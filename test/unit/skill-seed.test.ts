// skill-seed.test.ts — flair#2141 S2. The seed decision and its fail-closed
// orchestration, over an injected IO seam (no server).
import { describe, expect, it } from "bun:test";
import {
  decideSkillSeed,
  runSkillSeed,
  SEED_ASSIGNMENT_ID,
  SEED_REQUEST_TIMEOUT_MS,
  SEED_SKILL_ID,
  SEED_SKILL_WRITE_RETRY_BACKOFF_MS,
  SEED_SKILL_WRITE_TIMEOUT_MS,
  seedAssignmentProblems,
  seedRowProblems,
  skillSeedRestIo,
  type SeedAssignment,
  type SeedClock,
  type SeedCurrent,
  type SeedRead,
  type SeedRowShape,
  type SeedWrite,
  type SkillSeedIo,
  type SkillSeedRestOptions,
} from "../../src/lib/skill-seed.js";
import { USING_FLAIR_SKILL_CONTENT, usingFlairSkillHash } from "../../src/lib/using-flair-skill.js";
import { SEED_SKILL_ROW_ID } from "../../resources/seed-ids.js";
import { memoryProviderTimeoutResponse, writeOutcomeUnknownResponse } from "../../resources/memory-write-lock.js";

const CURRENT = "the current shipped text";
const CURRENT_HASH = usingFlairSkillHash(CURRENT);
const OLD = "an older shipped text";
const LOCAL = "text whose hash is not listed";
const OPERATOR = "admin";

const current: SeedCurrent = {
  name: "using-flair",
  content: CURRENT,
  trigger: "use when…",
  hashes: [CURRENT_HASH, usingFlairSkillHash(OLD)],
  priority: "standard",
};

/** A live, operator-owned org skill row holding `content`. */
const liveRow = (content: unknown, extra: Partial<SeedRowShape> = {}): SeedRowShape => ({
  id: SEED_SKILL_ID, agentId: OPERATOR, content, tags: ["skill"], durability: "persistent", visibility: "shared", archived: false, ...extra,
});

/** The seed's own assignment. */
const seedAssignment = (extra: Partial<SeedAssignment> = {}): SeedAssignment => ({
  id: SEED_ASSIGNMENT_ID, skillName: "using-flair", skillRef: SEED_SKILL_ID, priority: "standard", ...extra,
});

interface Fake extends SkillSeedIo {
  calls: { putRow: number; putAssignment: number };
  /** The `timeoutMs` each skill-row write was given. */
  rowBudgets: Array<number | undefined>;
}

/**
 * A fake instance: `row` is the stored Memory row, `assignment` the stored org
 * assignment, `operatorAgent` the Agent record with the operator's id (none by
 * default). `putRow`/`putAssignment` write the value the matching `rowAfter` /
 * `assignmentAfter` says the following read returns (default: what the seed
 * wrote), so a broken write or a wrong read-back can be modelled.
 */
function fakeIo(opts: {
  row: SeedRead<SeedRowShape>;
  assignment?: SeedRead<SeedAssignment>;
  operatorAgent?: SeedRead<unknown>;
  putRow?: () => SeedWrite & { rowAfter?: SeedRead<SeedRowShape> };
  putAssignment?: () => SeedWrite & { assignmentAfter?: SeedRead<SeedAssignment> };
}): Fake {
  const calls = { putRow: 0, putAssignment: 0 };
  const rowBudgets: Array<number | undefined> = [];
  let row: SeedRead<SeedRowShape> = opts.row;
  let assignment: SeedRead<SeedAssignment> = opts.assignment ?? { ok: true, row: seedAssignment() };
  const io: Fake = {
    calls,
    rowBudgets,
    operator: OPERATOR,
    readRow: async () => row,
    readAssignment: async () => assignment,
    readOperatorAgent: async () => opts.operatorAgent ?? { ok: true, row: null },
    putRow: async (timeoutMs?: number) => {
      calls.putRow += 1;
      rowBudgets.push(timeoutMs);
      const outcome = opts.putRow?.() ?? { ok: true };
      if (outcome.ok) row = outcome.rowAfter ?? { ok: true, row: liveRow(CURRENT) };
      return outcome.ok ? { ok: true } : { ok: false, detail: outcome.detail ?? "HTTP 500", status: outcome.status, code: outcome.code };
    },
    putAssignment: async () => {
      calls.putAssignment += 1;
      const outcome = opts.putAssignment?.() ?? { ok: true };
      if (outcome.ok) assignment = outcome.assignmentAfter ?? { ok: true, row: seedAssignment() };
      return outcome.ok ? { ok: true } : { ok: false, detail: outcome.detail ?? "HTTP 500", status: outcome.status, code: outcome.code };
    },
  };
  return io;
}

const NO_WRITES = { putRow: 0, putAssignment: 0 };

describe("decideSkillSeed", () => {
  it("creates when there is no row", () => {
    expect(decideSkillSeed(null, CURRENT, current.hashes)).toBe("create");
  });
  it("is unchanged when the row already holds the current text", () => {
    expect(decideSkillSeed(CURRENT, CURRENT, current.hashes)).toBe("unchanged");
  });
  it("replaces a row whose text matches a listed shipped version", () => {
    expect(decideSkillSeed(OLD, CURRENT, current.hashes)).toBe("replace");
  });
  it("keeps a row whose text matches no listed shipped version", () => {
    expect(decideSkillSeed(LOCAL, CURRENT, current.hashes)).toBe("keep");
  });
});

describe("shipped using-flair text", () => {
  it("separates behavior from advice and leaves liveness to Presence", () => {
    expect(USING_FLAIR_SKILL_CONTENT).toContain("## Current Flair behavior");
    expect(USING_FLAIR_SKILL_CONTENT).toContain("## Recommended practice");
    expect(USING_FLAIR_SKILL_CONTENT).not.toContain("one row per principal");
    expect(USING_FLAIR_SKILL_CONTENT).toContain("`activity` describes work; it is not a liveness verdict");
  });
});

describe("runSkillSeed", () => {
  it("names the same skill row id as the server's reserved id", () => {
    expect(SEED_SKILL_ID).toBe(SEED_SKILL_ROW_ID);
  });

  it("creates the row and the org assignment when none exists", async () => {
    const io = fakeIo({ row: { ok: true, row: null }, assignment: { ok: true, row: null } });
    const out = await runSkillSeed(io, current);
    expect(out).toMatchObject({ kind: "ok", action: "create", skillId: SEED_SKILL_ID, assignmentId: SEED_ASSIGNMENT_ID });
    expect(io.calls).toEqual({ putRow: 1, putAssignment: 1 });
  });

  it("changes nothing on a re-run and does not duplicate the assignment", async () => {
    const io = fakeIo({ row: { ok: true, row: liveRow(CURRENT) } });
    const out = await runSkillSeed(io, current);
    expect(out).toMatchObject({ kind: "ok", action: "unchanged", assignmentId: SEED_ASSIGNMENT_ID });
    expect(io.calls).toEqual(NO_WRITES);
  });

  it("replaces an operator-owned row whose text matches a listed shipped version", async () => {
    const io = fakeIo({ row: { ok: true, row: liveRow(OLD) } });
    const out = await runSkillSeed(io, current);
    expect(out).toMatchObject({ kind: "ok", action: "replace" });
    expect(io.calls).toEqual({ putRow: 1, putAssignment: 0 });
  });

  it("keeps an operator-owned row with other text, reports it, and still ensures the assignment", async () => {
    const io = fakeIo({ row: { ok: true, row: liveRow(LOCAL) }, assignment: { ok: true, row: null } });
    const out = await runSkillSeed(io, current);
    expect(out).toMatchObject({ kind: "ok", action: "keep" });
    expect((out as { message: string }).message).toContain("kept it unchanged");
    expect(io.calls).toEqual({ putRow: 0, putAssignment: 1 });
  });

  it("refuses a malformed row (content is not text) and writes nothing", async () => {
    const io = fakeIo({ row: { ok: true, row: liveRow(123) } });
    const out = await runSkillSeed(io, current);
    expect(out).toMatchObject({ kind: "refused", error: "skill_seed_row_malformed" });
    expect(io.calls).toEqual(NO_WRITES);
  });

  it("refuses when the existing row cannot be read, and writes nothing", async () => {
    const io = fakeIo({ row: { ok: false, detail: "HTTP 500" } });
    const out = await runSkillSeed(io, current);
    expect(out).toMatchObject({ kind: "refused", error: "skill_seed_row_unreadable" });
    expect(io.calls).toEqual(NO_WRITES);
  });

  it("refuses when the existing assignment cannot be read, and writes nothing", async () => {
    const io = fakeIo({ row: { ok: true, row: null }, assignment: { ok: false, detail: "HTTP 500" } });
    const out = await runSkillSeed(io, current);
    expect(out).toMatchObject({ kind: "refused", error: "skill_seed_assignment_unreadable" });
    expect(io.calls).toEqual(NO_WRITES);
  });

  it("refuses an existing assignment that names another skillRef", async () => {
    const io = fakeIo({ row: { ok: true, row: null }, assignment: { ok: true, row: seedAssignment({ skillRef: "some-other-row" }) } });
    const out = await runSkillSeed(io, current);
    expect(out).toMatchObject({ kind: "refused", error: "skill_seed_assignment_mismatch" });
    expect(io.calls).toEqual(NO_WRITES);
  });

  it("refuses when the row write fails", async () => {
    const io = fakeIo({ row: { ok: true, row: null }, putRow: () => ({ ok: false, detail: "HTTP 403" }) });
    const out = await runSkillSeed(io, current);
    expect(out).toMatchObject({ kind: "refused", error: "skill_seed_write_failed" });
    expect(io.calls).toEqual({ putRow: 1, putAssignment: 0 });
  });

  it("refuses when the row does not hold the current text after the write", async () => {
    const io = fakeIo({
      row: { ok: true, row: null },
      putRow: () => ({ ok: true, rowAfter: { ok: true, row: liveRow("something else") } }),
    });
    const out = await runSkillSeed(io, current);
    expect(out).toMatchObject({ kind: "refused", error: "skill_seed_verify_failed" });
  });

  it("refuses when the assignment write fails", async () => {
    const io = fakeIo({
      row: { ok: true, row: liveRow(CURRENT) },
      assignment: { ok: true, row: null },
      putAssignment: () => ({ ok: false, detail: "HTTP 403" }),
    });
    const out = await runSkillSeed(io, current);
    expect(out).toMatchObject({ kind: "refused", error: "skill_seed_write_failed" });
  });

  it("refuses when the assignment does not point at the skill row after the write", async () => {
    const io = fakeIo({
      row: { ok: true, row: liveRow(CURRENT) },
      assignment: { ok: true, row: null },
      putAssignment: () => ({ ok: true, assignmentAfter: { ok: true, row: seedAssignment({ skillRef: "some-other-row" }) } }),
    });
    const out = await runSkillSeed(io, current);
    expect(out).toMatchObject({ kind: "refused", error: "skill_seed_verify_failed" });
  });
});

// ─── Who owns the row: the operator, and nobody else holding that id ─────────

describe("runSkillSeed — ownership", () => {
  it("refuses an existing row owned by an agent, names the row, writes nothing, and gives the remedy", async () => {
    const io = fakeIo({ row: { ok: true, row: liveRow(CURRENT, { agentId: "some-agent" }) }, assignment: { ok: true, row: null } });
    const out = await runSkillSeed(io, current);
    expect(out).toMatchObject({ kind: "refused", error: "skill_seed_row_foreign_owner" });
    const message = (out as { message: string }).message;
    expect(message).toContain(`"${SEED_SKILL_ID}"`);
    expect(message).toContain('"some-agent"');
    expect(message).toContain("the seed wrote neither seed row");
    expect(message).toContain("DELETE /Memory/skill%3Ausing-flair");
    expect(message).toContain("re-run 'flair init'");
    expect(io.calls).toEqual(NO_WRITES);
  });

  it("refuses when an Agent record has the operator's id, even for an operator-owned row", async () => {
    const io = fakeIo({ row: { ok: true, row: liveRow(CURRENT) }, operatorAgent: { ok: true, row: { id: OPERATOR } } });
    const out = await runSkillSeed(io, current);
    expect(out).toMatchObject({ kind: "refused", error: "skill_seed_operator_ambiguous" });
    expect((out as { message: string }).message).toContain("the seed wrote neither seed row");
    expect(io.calls).toEqual(NO_WRITES);
  });

  it("refuses before creating a row when an Agent record has the operator's id", async () => {
    const io = fakeIo({ row: { ok: true, row: null }, assignment: { ok: true, row: null }, operatorAgent: { ok: true, row: { id: OPERATOR } } });
    expect(await runSkillSeed(io, current)).toMatchObject({ kind: "refused", error: "skill_seed_operator_ambiguous" });
    expect(io.calls).toEqual(NO_WRITES);
  });

  it("refuses when the operator's Agent lookup fails, and writes nothing", async () => {
    const io = fakeIo({ row: { ok: true, row: null }, operatorAgent: { ok: false, detail: "HTTP 500" } });
    expect(await runSkillSeed(io, current)).toMatchObject({ kind: "refused", error: "skill_seed_operator_unreadable" });
    expect(io.calls).toEqual(NO_WRITES);
  });

  it("refuses a row read back after the write that another principal owns", async () => {
    const io = fakeIo({ row: { ok: true, row: null }, putRow: () => ({ ok: true, rowAfter: { ok: true, row: liveRow(CURRENT, { agentId: "x" }) } }) });
    expect(await runSkillSeed(io, current)).toMatchObject({ kind: "refused", error: "skill_seed_verify_failed" });
  });
});

// ─── What a live, readable org using-flair skill needs (flair#2141 S2) ───────

describe("runSkillSeed — rows outside the seed's required shape are refused", () => {
  const rowCases: Array<[string, Partial<SeedRowShape>, string]> = [
    ["no skill tag", { tags: ["note"] }, 'no "skill" tag'],
    ["no tags at all", { tags: undefined }, 'no "skill" tag'],
    ["private visibility", { visibility: "private" }, 'visibility is "private"'],
    ["standard durability", { durability: "standard" }, 'durability is "standard"'],
    ["missing durability", { durability: undefined }, 'durability is null'],
    ["archived", { archived: true }, "archived"],
    ["closed by a supersede", { validTo: "2000-01-01T00:00:00.000Z" }, "closed"],
    ["expired", { expiresAt: "2000-01-01T00:00:00.000Z" }, "expired"],
  ];
  for (const [label, extra, phrase] of rowCases) {
    it(`refuses an existing current-text row with ${label}, and writes nothing`, async () => {
      const io = fakeIo({ row: { ok: true, row: liveRow(CURRENT, extra) }, assignment: { ok: true, row: null } });
      const out = await runSkillSeed(io, current);
      expect(out).toMatchObject({ kind: "refused", error: "skill_seed_row_incomplete" });
      expect((out as { message: string }).message).toContain(phrase);
      expect((out as { message: string }).message).toContain("the seed wrote neither seed row");
      expect(io.calls).toEqual(NO_WRITES);
    });
  }

  it("refuses a listed shipped version that is archived instead of replacing it", async () => {
    const io = fakeIo({ row: { ok: true, row: liveRow(OLD, { archived: true }) } });
    expect(await runSkillSeed(io, current)).toMatchObject({ kind: "refused", error: "skill_seed_row_incomplete" });
    expect(io.calls).toEqual(NO_WRITES);
  });

  const assignmentCases: Array<[string, Partial<SeedAssignment>, string]> = [
    ["a different skillName", { skillName: "something-else" }, 'skillName is "something-else"'],
    ["a non-standard priority", { priority: "critical" }, 'priority is "critical"'],
    ["another id", { id: "org-skill:other" }, 'id is "org-skill:other"'],
  ];
  for (const [label, extra, phrase] of assignmentCases) {
    it(`refuses an existing assignment with ${label}, and writes nothing`, async () => {
      const io = fakeIo({ row: { ok: true, row: liveRow(CURRENT) }, assignment: { ok: true, row: seedAssignment(extra) } });
      const out = await runSkillSeed(io, current);
      expect(out).toMatchObject({ kind: "refused", error: "skill_seed_assignment_mismatch" });
      expect((out as { message: string }).message).toContain(phrase);
      expect(io.calls).toEqual(NO_WRITES);
    });
  }

  it("refuses a row read back after the write without the skill tag", async () => {
    const io = fakeIo({ row: { ok: true, row: null }, putRow: () => ({ ok: true, rowAfter: { ok: true, row: liveRow(CURRENT, { tags: [] }) } }) });
    const out = await runSkillSeed(io, current);
    expect(out).toMatchObject({ kind: "refused", error: "skill_seed_verify_failed" });
    expect(io.calls).toEqual({ putRow: 1, putAssignment: 0 });
  });

  it("refuses a row read back after the write as private", async () => {
    const io = fakeIo({ row: { ok: true, row: null }, putRow: () => ({ ok: true, rowAfter: { ok: true, row: liveRow(CURRENT, { visibility: "private" }) } }) });
    expect(await runSkillSeed(io, current)).toMatchObject({ kind: "refused", error: "skill_seed_verify_failed" });
  });

  it("refuses a row read back with nonpersistent durability before writing the assignment", async () => {
    const io = fakeIo({ row: { ok: true, row: null }, putRow: () => ({ ok: true, rowAfter: { ok: true, row: liveRow(CURRENT, { durability: "standard" }) } }) });
    expect(await runSkillSeed(io, current)).toMatchObject({ kind: "refused", error: "skill_seed_verify_failed" });
    expect(io.calls).toEqual({ putRow: 1, putAssignment: 0 });
  });

  it("refuses when the row read-back itself fails", async () => {
    let reads = 0;
    const io = fakeIo({ row: { ok: true, row: null } });
    const readRow = io.readRow;
    io.readRow = async () => (++reads === 1 ? readRow() : { ok: false, detail: "HTTP 503" });
    const out = await runSkillSeed(io, current);
    expect(out).toMatchObject({ kind: "refused", error: "skill_seed_verify_failed" });
    expect((out as { message: string }).message).toContain("could not be read back");
    expect(io.calls).toEqual({ putRow: 1, putAssignment: 0 });
  });

  it("refuses an assignment read back after the write with a different skillName", async () => {
    const io = fakeIo({
      row: { ok: true, row: liveRow(CURRENT) },
      assignment: { ok: true, row: null },
      putAssignment: () => ({ ok: true, assignmentAfter: { ok: true, row: seedAssignment({ skillName: "x" }) } }),
    });
    expect(await runSkillSeed(io, current)).toMatchObject({ kind: "refused", error: "skill_seed_verify_failed" });
  });

  it("the checks accept the seed's own rows", () => {
    expect(seedRowProblems(liveRow(CURRENT))).toEqual([]);
    expect(seedAssignmentProblems(seedAssignment(), current)).toEqual([]);
  });
});

// ─── A skill-row write refused with 503 memory_provider_timeout ──────────────
// The server states nothing was written, so the seed runs its pass again while
// the skill-write bound leaves time. The clock is a fake, so no test waits.

const PROVIDER_TIMEOUT: SeedWrite = {
  ok: false,
  detail: 'HTTP 503: {"error":"memory_provider_timeout"}',
  status: 503,
  code: "memory_provider_timeout",
};

/** How long the instance takes to refuse one write in these tests. */
const REFUSAL_AFTER_MS = 28_000;

/** A fake clock: `pause` records each wait and moves time forward by it. */
function fakeClock(): SeedClock & { t: number; waits: number[] } {
  const clock = {
    t: 0,
    waits: [] as number[],
    now: () => clock.t,
    pause: async (ms: number) => {
      clock.waits.push(ms);
      clock.t += ms;
    },
  };
  return clock;
}

describe("runSkillSeed — a skill-row write refused with 503 memory_provider_timeout", () => {
  it("retries after one timeout, writes the row once, then writes the assignment", async () => {
    const clock = fakeClock();
    let attempts = 0;
    let written = 0;
    const io = fakeIo({
      row: { ok: true, row: null },
      assignment: { ok: true, row: null },
      putRow: () => {
        if (++attempts === 1) {
          clock.t += REFUSAL_AFTER_MS;
          return PROVIDER_TIMEOUT;
        }
        written++;
        return { ok: true };
      },
    });
    const out = await runSkillSeed(io, current, clock);
    expect(out).toMatchObject({ kind: "ok", action: "create", skillId: SEED_SKILL_ID, assignmentId: SEED_ASSIGNMENT_ID });
    expect(written).toBe(1);
    expect(io.calls).toEqual({ putRow: 2, putAssignment: 1 });
    expect(clock.waits).toEqual([SEED_SKILL_WRITE_RETRY_BACKOFF_MS]);
    // The second attempt waits at most what is left of the bound.
    expect(io.rowBudgets).toEqual([
      SEED_SKILL_WRITE_TIMEOUT_MS,
      SEED_SKILL_WRITE_TIMEOUT_MS - REFUSAL_AFTER_MS - SEED_SKILL_WRITE_RETRY_BACKOFF_MS,
    ]);
  }, 5_000);

  it("retries until the 180 s skill-write bound leaves no time, then refuses with the attempts and the time spent", async () => {
    // The stub stops refusing after 50 calls, so a retry loop without a bound
    // ends in success instead of hanging.
    const clock = fakeClock();
    let attempts = 0;
    const io = fakeIo({
      row: { ok: true, row: null },
      assignment: { ok: true, row: null },
      putRow: () => {
        if (++attempts > 50) return { ok: true };
        clock.t += REFUSAL_AFTER_MS;
        return PROVIDER_TIMEOUT;
      },
    });
    const out = await runSkillSeed(io, current, clock);
    expect(SEED_SKILL_WRITE_TIMEOUT_MS).toBe(180_000);
    expect(SEED_SKILL_WRITE_RETRY_BACKOFF_MS).toBe(2_000);
    // 28 s per refusal plus a 2 s wait: the sixth refusal comes at 178 s, and
    // another 2 s wait would reach the bound.
    expect(out).toMatchObject({ kind: "refused", error: "skill_seed_write_failed" });
    const message = (out as { message: string }).message;
    expect(message).toContain("memory_provider_timeout on 6 attempts over 178 s");
    expect(message).toContain("the 180 s bound on that write leaves no time for another");
    expect(message).toContain("the org assignment was not written. Re-run 'flair init'");
    expect(io.calls).toEqual({ putRow: 6, putAssignment: 0 });
    expect(io.rowBudgets).toEqual([180_000, 150_000, 120_000, 90_000, 60_000, 30_000]);
    expect(clock.waits).toEqual([2_000, 2_000, 2_000, 2_000, 2_000]);
    expect(clock.t).toBe(178_000);
  }, 5_000);

  const otherFailures: Array<[string, SeedWrite]> = [
    ["HTTP 500 with the timeout code", { ok: false, detail: "HTTP 500", status: 500, code: "memory_provider_timeout" }],
    ["HTTP 503 memory_busy", { ok: false, detail: "HTTP 503", status: 503, code: "memory_busy" }],
    ["HTTP 503 write_outcome_unknown", { ok: false, detail: "HTTP 503", status: 503, code: "write_outcome_unknown" }],
    ["HTTP 503 without a code", { ok: false, detail: "HTTP 503", status: 503 }],
    ["a transport failure", { ok: false, detail: "the request failed: connection refused" }],
  ];
  for (const [label, failure] of otherFailures) {
    it(`refuses ${label} after one attempt`, async () => {
      const clock = fakeClock();
      const io = fakeIo({ row: { ok: true, row: null }, putRow: () => failure });
      const out = await runSkillSeed(io, current, clock);
      expect(out).toMatchObject({ kind: "refused", error: "skill_seed_write_failed" });
      expect((out as { message: string }).message).not.toContain("attempts");
      expect(io.calls).toEqual({ putRow: 1, putAssignment: 0 });
      expect(clock.waits).toEqual([]);
    }, 5_000);
  }

  it("does not retry the assignment write on the timeout code", async () => {
    const clock = fakeClock();
    const io = fakeIo({ row: { ok: true, row: liveRow(CURRENT) }, assignment: { ok: true, row: null }, putAssignment: () => PROVIDER_TIMEOUT });
    expect(await runSkillSeed(io, current, clock)).toMatchObject({ kind: "refused", error: "skill_seed_write_failed" });
    expect(io.calls).toEqual({ putRow: 0, putAssignment: 1 });
    expect(clock.waits).toEqual([]);
  }, 5_000);

  it("re-reads before the retry: a row another principal holds by then is refused, not overwritten", async () => {
    const clock = fakeClock();
    const io = fakeIo({ row: { ok: true, row: null }, assignment: { ok: true, row: null }, putRow: () => PROVIDER_TIMEOUT });
    const pause = clock.pause;
    clock.pause = async (ms) => {
      await pause(ms);
      io.readRow = async () => ({ ok: true, row: liveRow(CURRENT, { agentId: "agent-a" }) });
    };
    const out = await runSkillSeed(io, current, clock);
    expect(out).toMatchObject({ kind: "refused", error: "skill_seed_row_foreign_owner" });
    expect(io.calls).toEqual({ putRow: 1, putAssignment: 0 });
  }, 5_000);

  it("refuses without another write when the bound passes while a retried pass re-reads", async () => {
    const clock = fakeClock();
    const io = fakeIo({
      row: { ok: true, row: null },
      assignment: { ok: true, row: null },
      putRow: () => {
        clock.t += REFUSAL_AFTER_MS;
        return PROVIDER_TIMEOUT;
      },
    });
    let reads = 0;
    const readRow = io.readRow;
    io.readRow = async () => {
      if (++reads === 2) clock.t += SEED_SKILL_WRITE_TIMEOUT_MS;
      return readRow();
    };
    const out = await runSkillSeed(io, current, clock);
    expect(out).toMatchObject({ kind: "refused", error: "skill_seed_write_failed" });
    expect((out as { message: string }).message).toContain("passed while the seed re-read the instance");
    expect(io.calls).toEqual({ putRow: 1, putAssignment: 0 });
  }, 5_000);
});

// ─── The REST seam against a slow instance ───────────────────────────────────
// The instance embeds a skill row as it writes it, and the first embed waits
// for the embedding model to become ready. This may require a download after
// Harper reports healthy.
// This fake instance answers each request after a per-route delay, honours the
// client's abort, and models the case where an abandoned PUT still finishes.

interface SlowInstance {
  rows: Map<string, Record<string, unknown>>;
  puts: string[];
  delays: { memoryPut: number; assignmentPut: number; read: number };
  fetch: typeof fetch;
}

function slowInstance(delays: Partial<SlowInstance["delays"]> = {}): SlowInstance {
  const rows = new Map<string, Record<string, unknown>>();
  const puts: string[] = [];
  const d = { memoryPut: 0, assignmentPut: 0, read: 0, ...delays };
  const answerAfter = (ms: number, signal: AbortSignal | null | undefined, make: () => Response): Promise<Response> =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const timer = setTimeout(() => resolve(make()), ms);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(signal.reason);
        },
        { once: true },
      );
    });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const [, table, rawId] = url.pathname.split("/");
    const id = decodeURIComponent(rawId ?? "");
    const key = `${table}/${id}`;
    if ((init?.method ?? "GET") === "PUT") {
      puts.push(key);
      const ms = table === "Memory" ? d.memoryPut : d.assignmentPut;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      // This fake lands the write whether or not the client still waits; the
      // real instance may or may not, so the test only models the case where it does.
      setTimeout(() => rows.set(key, { ...body, id }), ms);
      return answerAfter(ms, init?.signal, () => new Response(null, { status: 204 }));
    }
    return answerAfter(d.read, init?.signal, () => {
      const row = rows.get(key);
      return row ? Response.json(row) : new Response("not found", { status: 404 });
    });
  }) as typeof fetch;
  return { rows, puts, delays: d, fetch: fetchImpl };
}

function restOptions(instance: SlowInstance, extra: Partial<SkillSeedRestOptions> = {}): SkillSeedRestOptions {
  return { baseUrl: "http://127.0.0.1:1", user: "admin", pass: "pw", fetchImpl: instance.fetch, ...extra };
}

describe("skillSeedRestIo — a slow first skill-row write", () => {
  it("gives the skill-row write its own, longer bound than the reads", () => {
    expect(SEED_SKILL_WRITE_TIMEOUT_MS).toBeGreaterThan(SEED_REQUEST_TIMEOUT_MS);
    // Under the 300 s default headers timeout of Node's fetch, so this bound fires first.
    expect(SEED_SKILL_WRITE_TIMEOUT_MS).toBeLessThan(300_000);
  });

  it("completes a skill-row write that outlasts the request bound, and says what it is waiting on", async () => {
    const instance = slowInstance({ memoryPut: 150 });
    const notices: string[] = [];
    const io = skillSeedRestIo(
      restOptions(instance, {
        requestTimeoutMs: 40,
        skillWriteTimeoutMs: 2_000,
        skillWriteNoticeMs: 20,
        notify: (line) => notices.push(line),
      }),
      current,
    );
    const out = await runSkillSeed(io, current);
    expect(out).toMatchObject({ kind: "ok", action: "create", skillId: SEED_SKILL_ID, assignmentId: SEED_ASSIGNMENT_ID });
    expect(instance.puts).toEqual([`Memory/${SEED_SKILL_ID}`, `OrgSkillAssignment/${SEED_ASSIGNMENT_ID}`]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("embedding model");
  });

  it("says nothing extra when the skill-row write answers promptly", async () => {
    const instance = slowInstance();
    const notices: string[] = [];
    const io = skillSeedRestIo(
      restOptions(instance, { skillWriteNoticeMs: 50, notify: (line) => notices.push(line) }),
      current,
    );
    expect(await runSkillSeed(io, current)).toMatchObject({ kind: "ok", action: "create" });
    await Bun.sleep(80);
    expect(notices).toEqual([]);
  });

  it("refuses past its own bound, names the model wait, writes no assignment, and a re-run adds no second row", async () => {
    const instance = slowInstance({ memoryPut: 250 });
    const slow = skillSeedRestIo(restOptions(instance, { requestTimeoutMs: 40, skillWriteTimeoutMs: 60 }), current);
    const out = await runSkillSeed(slow, current);
    expect(out).toMatchObject({ kind: "refused", error: "skill_seed_write_failed" });
    const message = (out as { message: string }).message;
    expect(message).toContain("no answer within 0.1 s");
    expect(message).toContain("waits for its embedding model, which may need to download or load");
    expect(message).toContain("the org assignment was not written. Re-run 'flair init'");
    expect(instance.puts).toEqual([`Memory/${SEED_SKILL_ID}`]);

    // When the instance lands the write it was given, the re-run reads the
    // fixed id, finds the current text, and writes only the missing assignment.
    await Bun.sleep(300);
    instance.delays.memoryPut = 0;
    const rerun = await runSkillSeed(skillSeedRestIo(restOptions(instance), current), current);
    expect(rerun).toMatchObject({ kind: "ok", action: "unchanged", assignmentId: SEED_ASSIGNMENT_ID });
    expect(instance.puts).toEqual([`Memory/${SEED_SKILL_ID}`, `OrgSkillAssignment/${SEED_ASSIGNMENT_ID}`]);
  });

  it("keeps the short bound on the reads, and writes nothing when a read times out", async () => {
    const instance = slowInstance({ read: 200 });
    const io = skillSeedRestIo(restOptions(instance, { requestTimeoutMs: 30, skillWriteTimeoutMs: 5_000 }), current);
    const out = await runSkillSeed(io, current);
    expect(out).toMatchObject({ kind: "refused", error: "skill_seed_row_unreadable" });
    expect(instance.puts).toEqual([]);
  });

  it("keeps the short bound on the assignment write", async () => {
    const instance = slowInstance({ assignmentPut: 200 });
    const io = skillSeedRestIo(restOptions(instance, { requestTimeoutMs: 30, skillWriteTimeoutMs: 5_000 }), current);
    const out = await runSkillSeed(io, current);
    expect(out).toMatchObject({ kind: "refused", error: "skill_seed_write_failed" });
    expect((out as { message: string }).message).toContain(`"${SEED_ASSIGNMENT_ID}" org assignment failed (no answer within`);
  });
});

describe("skillSeedRestIo — the instance's 503 refusals of the skill-row write", () => {
  /** A `slowInstance` whose next Memory PUTs answer `refusals` in order, after `delayMs`, writing nothing. */
  function refusingInstance(refusals: Array<() => Response>, delayMs = 0): SlowInstance {
    const instance = slowInstance();
    const inner = instance.fetch;
    instance.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const isMemoryPut = (init?.method ?? "GET") === "PUT" && new URL(String(input)).pathname.startsWith("/Memory/");
      const refusal = isMemoryPut ? refusals.shift() : undefined;
      if (!refusal) return inner(input, init);
      instance.puts.push(`Memory/${SEED_SKILL_ID}`);
      if (delayMs > 0) await Bun.sleep(delayMs);
      return refusal();
    }) as typeof fetch;
    return instance;
  }

  it("retries the server's memory_provider_timeout refusal, then seeds both rows", async () => {
    const instance = refusingInstance([memoryProviderTimeoutResponse]);
    const clock = fakeClock();
    const out = await runSkillSeed(skillSeedRestIo(restOptions(instance), current), current, clock);
    expect(out).toMatchObject({ kind: "ok", action: "create", assignmentId: SEED_ASSIGNMENT_ID });
    expect(instance.puts).toEqual([`Memory/${SEED_SKILL_ID}`, `Memory/${SEED_SKILL_ID}`, `OrgSkillAssignment/${SEED_ASSIGNMENT_ID}`]);
    expect(instance.rows.get(`Memory/${SEED_SKILL_ID}`)).toMatchObject({ content: CURRENT, agentId: "admin" });
    expect(clock.waits).toEqual([SEED_SKILL_WRITE_RETRY_BACKOFF_MS]);
  }, 5_000);

  it("refuses once the io's own skill-write bound leaves no time for another attempt", async () => {
    const instance = refusingInstance(Array.from({ length: 50 }, () => memoryProviderTimeoutResponse));
    const clock = fakeClock();
    const io = skillSeedRestIo(restOptions(instance, { skillWriteTimeoutMs: 10_000 }), current);
    const out = await runSkillSeed(io, current, clock);
    // The refusals take no fake time: attempts at 0, 2, 4, 6 and 8 s, and a
    // 2 s wait after the fifth would reach the 10 s bound.
    expect(out).toMatchObject({ kind: "refused", error: "skill_seed_write_failed" });
    expect((out as { message: string }).message).toContain("on 5 attempts over 8 s, and the 10 s bound");
    expect(instance.puts).toEqual(Array.from({ length: 5 }, () => `Memory/${SEED_SKILL_ID}`));
  }, 5_000);

  it("refuses the server's write_outcome_unknown refusal after one PUT", async () => {
    const instance = refusingInstance([writeOutcomeUnknownResponse]);
    const clock = fakeClock();
    const out = await runSkillSeed(skillSeedRestIo(restOptions(instance), current), current, clock);
    expect(out).toMatchObject({ kind: "refused", error: "skill_seed_write_failed" });
    expect(instance.puts).toEqual([`Memory/${SEED_SKILL_ID}`]);
    expect(clock.waits).toEqual([]);
  }, 5_000);

  it("says what it is waiting on once, across two slow attempts", async () => {
    const instance = refusingInstance([memoryProviderTimeoutResponse], 80);
    instance.delays.memoryPut = 80;
    const notices: string[] = [];
    const io = skillSeedRestIo(
      restOptions(instance, { skillWriteNoticeMs: 20, notify: (line) => notices.push(line) }),
      current,
    );
    expect(await runSkillSeed(io, current, fakeClock())).toMatchObject({ kind: "ok", action: "create" });
    expect(instance.puts).toEqual([`Memory/${SEED_SKILL_ID}`, `Memory/${SEED_SKILL_ID}`, `OrgSkillAssignment/${SEED_ASSIGNMENT_ID}`]);
    expect(notices).toHaveLength(1);
  }, 5_000);
});
