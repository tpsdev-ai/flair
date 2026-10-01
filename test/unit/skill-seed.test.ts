// skill-seed.test.ts — flair#2141 S2. The seed decision and its fail-closed
// orchestration, over an injected IO seam (no server).
import { describe, expect, it } from "bun:test";
import {
  decideSkillSeed,
  runSkillSeed,
  SEED_ASSIGNMENT_ID,
  SEED_REQUEST_TIMEOUT_MS,
  SEED_SKILL_ID,
  SEED_SKILL_WRITE_TIMEOUT_MS,
  seedAssignmentProblems,
  seedRowProblems,
  skillSeedRestIo,
  type SeedAssignment,
  type SeedCurrent,
  type SeedRead,
  type SeedRowShape,
  type SkillSeedIo,
  type SkillSeedRestOptions,
} from "../../src/lib/skill-seed.js";
import { usingFlairSkillHash } from "../../src/lib/using-flair-skill.js";
import { SEED_SKILL_ROW_ID } from "../../resources/seed-ids.js";

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
  id: SEED_SKILL_ID, agentId: OPERATOR, content, tags: ["skill"], visibility: "shared", archived: false, ...extra,
});

/** The seed's own assignment. */
const seedAssignment = (extra: Partial<SeedAssignment> = {}): SeedAssignment => ({
  id: SEED_ASSIGNMENT_ID, skillName: "using-flair", skillRef: SEED_SKILL_ID, priority: "standard", ...extra,
});

interface Fake extends SkillSeedIo {
  calls: { putRow: number; putAssignment: number };
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
  putRow?: () => { ok: boolean; detail?: string; rowAfter?: SeedRead<SeedRowShape> };
  putAssignment?: () => { ok: boolean; detail?: string; assignmentAfter?: SeedRead<SeedAssignment> };
}): Fake {
  const calls = { putRow: 0, putAssignment: 0 };
  let row: SeedRead<SeedRowShape> = opts.row;
  let assignment: SeedRead<SeedAssignment> = opts.assignment ?? { ok: true, row: seedAssignment() };
  const io: Fake = {
    calls,
    operator: OPERATOR,
    readRow: async () => row,
    readAssignment: async () => assignment,
    readOperatorAgent: async () => opts.operatorAgent ?? { ok: true, row: null },
    putRow: async () => {
      calls.putRow += 1;
      const outcome = opts.putRow?.() ?? { ok: true };
      if (outcome.ok) row = outcome.rowAfter ?? { ok: true, row: liveRow(CURRENT) };
      return outcome.ok ? { ok: true } : { ok: false, detail: outcome.detail ?? "HTTP 500" };
    },
    putAssignment: async () => {
      calls.putAssignment += 1;
      const outcome = opts.putAssignment?.() ?? { ok: true };
      if (outcome.ok) assignment = outcome.assignmentAfter ?? { ok: true, row: seedAssignment() };
      return outcome.ok ? { ok: true } : { ok: false, detail: outcome.detail ?? "HTTP 500" };
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
    expect(message).toContain("init wrote nothing");
    expect(message).toContain("DELETE /Memory/skill%3Ausing-flair");
    expect(message).toContain("re-run 'flair init'");
    expect(io.calls).toEqual(NO_WRITES);
  });

  it("refuses when an Agent record has the operator's id, even for an operator-owned row", async () => {
    const io = fakeIo({ row: { ok: true, row: liveRow(CURRENT) }, operatorAgent: { ok: true, row: { id: OPERATOR } } });
    const out = await runSkillSeed(io, current);
    expect(out).toMatchObject({ kind: "refused", error: "skill_seed_operator_ambiguous" });
    expect((out as { message: string }).message).toContain("init wrote nothing");
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

describe("runSkillSeed — a row or assignment the manifest cannot resolve is refused", () => {
  const rowCases: Array<[string, Partial<SeedRowShape>, string]> = [
    ["no skill tag", { tags: ["note"] }, 'no "skill" tag'],
    ["no tags at all", { tags: undefined }, 'no "skill" tag'],
    ["private visibility", { visibility: "private" }, 'visibility is "private"'],
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
      expect((out as { message: string }).message).toContain("init wrote nothing");
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

// ─── The REST seam against a slow instance ───────────────────────────────────
// The instance embeds a skill row as it writes it, and the first embed waits
// for the embedding model to download and load — after Harper reports healthy.
// This fake instance answers each request after a per-route delay, honours the
// client's abort, and (like Harper) still finishes a PUT the client gave up on.

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
    expect(message).toContain("embedding model");
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
