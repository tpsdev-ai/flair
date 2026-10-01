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
  skillSeedRestIo,
  type SeedAssignment,
  type SeedCurrent,
  type SeedRead,
  type SeedRowShape,
  type SkillSeedIo,
  type SkillSeedRestOptions,
} from "../../src/lib/skill-seed.js";
import { usingFlairSkillHash } from "../../src/lib/using-flair-skill.js";

const CURRENT = "the current shipped text";
const CURRENT_HASH = usingFlairSkillHash(CURRENT);
const OLD = "an older shipped text";
const LOCAL = "locally modified, hash not shipped";

const current: SeedCurrent = {
  name: "using-flair",
  content: CURRENT,
  trigger: "use when…",
  hashes: [CURRENT_HASH, usingFlairSkillHash(OLD)],
  priority: "standard",
};

interface Fake extends SkillSeedIo {
  calls: { putRow: number; putAssignment: number };
}

/**
 * A fake instance: `row` is the stored Memory row, `assignment` the stored org
 * assignment. `putRow`/`putAssignment` write the value the matching `rowAfter`
 * / `assignmentAfter` says the following read returns (default: what the seed
 * wrote), so a broken write or a wrong read-back can be modelled.
 */
function fakeIo(opts: {
  row: SeedRead<SeedRowShape>;
  assignment?: SeedRead<SeedAssignment>;
  putRow?: () => { ok: boolean; detail?: string; rowAfter?: SeedRead<SeedRowShape> };
  putAssignment?: () => { ok: boolean; detail?: string; assignmentAfter?: SeedRead<SeedAssignment> };
}): Fake {
  const calls = { putRow: 0, putAssignment: 0 };
  let row: SeedRead<SeedRowShape> = opts.row;
  let assignment: SeedRead<SeedAssignment> = opts.assignment ?? { ok: true, row: { id: SEED_ASSIGNMENT_ID, skillName: "using-flair", skillRef: SEED_SKILL_ID } };
  const io: Fake = {
    calls,
    readRow: async () => row,
    readAssignment: async () => assignment,
    putRow: async () => {
      calls.putRow += 1;
      const outcome = opts.putRow?.() ?? { ok: true };
      if (outcome.ok) row = outcome.rowAfter ?? { ok: true, row: { id: SEED_SKILL_ID, content: CURRENT } };
      return outcome.ok ? { ok: true } : { ok: false, detail: outcome.detail ?? "HTTP 500" };
    },
    putAssignment: async () => {
      calls.putAssignment += 1;
      const outcome = opts.putAssignment?.() ?? { ok: true };
      if (outcome.ok) assignment = outcome.assignmentAfter ?? { ok: true, row: { id: SEED_ASSIGNMENT_ID, skillName: "using-flair", skillRef: SEED_SKILL_ID } };
      return outcome.ok ? { ok: true } : { ok: false, detail: outcome.detail ?? "HTTP 500" };
    },
  };
  return io;
}

describe("decideSkillSeed", () => {
  it("creates when there is no row", () => {
    expect(decideSkillSeed(null, CURRENT, current.hashes)).toBe("create");
  });
  it("is unchanged when the row already holds the current text", () => {
    expect(decideSkillSeed(CURRENT, CURRENT, current.hashes)).toBe("unchanged");
  });
  it("replaces an unedited shipped version (its hash is in the list)", () => {
    expect(decideSkillSeed(OLD, CURRENT, current.hashes)).toBe("replace");
  });
  it("keeps a locally modified row (its hash is not in the list)", () => {
    expect(decideSkillSeed(LOCAL, CURRENT, current.hashes)).toBe("keep");
  });
});

describe("runSkillSeed", () => {
  it("creates the row and the org assignment when none exists", async () => {
    const io = fakeIo({ row: { ok: true, row: null }, assignment: { ok: true, row: null } });
    const out = await runSkillSeed(io, current);
    expect(out).toMatchObject({ kind: "ok", action: "create", skillId: SEED_SKILL_ID, assignmentId: SEED_ASSIGNMENT_ID });
    expect(io.calls).toEqual({ putRow: 1, putAssignment: 1 });
  });

  it("changes nothing on a re-run and does not duplicate the assignment", async () => {
    const io = fakeIo({ row: { ok: true, row: { id: SEED_SKILL_ID, content: CURRENT } } });
    const out = await runSkillSeed(io, current);
    expect(out).toMatchObject({ kind: "ok", action: "unchanged", assignmentId: SEED_ASSIGNMENT_ID });
    expect(io.calls).toEqual({ putRow: 0, putAssignment: 0 });
  });

  it("replaces an unedited shipped version", async () => {
    const io = fakeIo({ row: { ok: true, row: { id: SEED_SKILL_ID, content: OLD } } });
    const out = await runSkillSeed(io, current);
    expect(out).toMatchObject({ kind: "ok", action: "replace" });
    expect(io.calls).toEqual({ putRow: 1, putAssignment: 0 });
  });

  it("keeps a locally modified row, reports it, and still ensures the assignment", async () => {
    const io = fakeIo({ row: { ok: true, row: { id: SEED_SKILL_ID, content: LOCAL } }, assignment: { ok: true, row: null } });
    const out = await runSkillSeed(io, current);
    expect(out).toMatchObject({ kind: "ok", action: "keep" });
    expect((out as { message: string }).message).toContain("kept it unchanged");
    expect(io.calls).toEqual({ putRow: 0, putAssignment: 1 });
  });

  it("refuses a malformed row (content is not text) and writes nothing", async () => {
    const io = fakeIo({ row: { ok: true, row: { id: SEED_SKILL_ID, content: 123 } } });
    const out = await runSkillSeed(io, current);
    expect(out).toMatchObject({ kind: "refused", error: "skill_seed_row_malformed" });
    expect(io.calls).toEqual({ putRow: 0, putAssignment: 0 });
  });

  it("refuses when the existing row cannot be read, and writes nothing", async () => {
    const io = fakeIo({ row: { ok: false, detail: "HTTP 500" } });
    const out = await runSkillSeed(io, current);
    expect(out).toMatchObject({ kind: "refused", error: "skill_seed_row_unreadable" });
    expect(io.calls).toEqual({ putRow: 0, putAssignment: 0 });
  });

  it("refuses when the existing assignment cannot be read, and writes nothing", async () => {
    const io = fakeIo({ row: { ok: true, row: null }, assignment: { ok: false, detail: "HTTP 500" } });
    const out = await runSkillSeed(io, current);
    expect(out).toMatchObject({ kind: "refused", error: "skill_seed_assignment_unreadable" });
    expect(io.calls).toEqual({ putRow: 0, putAssignment: 0 });
  });

  it("refuses an existing assignment that names another skillRef", async () => {
    const io = fakeIo({
      row: { ok: true, row: null },
      assignment: { ok: true, row: { id: SEED_ASSIGNMENT_ID, skillName: "using-flair", skillRef: "some-other-row" } },
    });
    const out = await runSkillSeed(io, current);
    expect(out).toMatchObject({ kind: "refused", error: "skill_seed_assignment_mismatch" });
    expect(io.calls).toEqual({ putRow: 0, putAssignment: 0 });
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
      putRow: () => ({ ok: true, rowAfter: { ok: true, row: { id: SEED_SKILL_ID, content: "something else" } } }),
    });
    const out = await runSkillSeed(io, current);
    expect(out).toMatchObject({ kind: "refused", error: "skill_seed_verify_failed" });
  });

  it("refuses when the assignment write fails", async () => {
    const io = fakeIo({
      row: { ok: true, row: { id: SEED_SKILL_ID, content: CURRENT } },
      assignment: { ok: true, row: null },
      putAssignment: () => ({ ok: false, detail: "HTTP 403" }),
    });
    const out = await runSkillSeed(io, current);
    expect(out).toMatchObject({ kind: "refused", error: "skill_seed_write_failed" });
  });

  it("refuses when the assignment does not point at the skill row after the write", async () => {
    const io = fakeIo({
      row: { ok: true, row: { id: SEED_SKILL_ID, content: CURRENT } },
      assignment: { ok: true, row: null },
      putAssignment: () => ({
        ok: true,
        assignmentAfter: { ok: true, row: { id: SEED_ASSIGNMENT_ID, skillName: "using-flair", skillRef: "some-other-row" } },
      }),
    });
    const out = await runSkillSeed(io, current);
    expect(out).toMatchObject({ kind: "refused", error: "skill_seed_verify_failed" });
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
      // The instance finishes the write whether or not the client still waits.
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

  it("refuses past its own bound, names the model wait, writes no assignment, and a re-run writes nothing twice", async () => {
    const instance = slowInstance({ memoryPut: 250 });
    const slow = skillSeedRestIo(restOptions(instance, { requestTimeoutMs: 40, skillWriteTimeoutMs: 60 }), current);
    const out = await runSkillSeed(slow, current);
    expect(out).toMatchObject({ kind: "refused", error: "skill_seed_write_failed" });
    const message = (out as { message: string }).message;
    expect(message).toContain("no answer within 0.1 s");
    expect(message).toContain("embedding model");
    expect(message).toContain("re-run 'flair init'");
    expect(instance.puts).toEqual([`Memory/${SEED_SKILL_ID}`]);

    // The instance finishes the write it was given; the re-run reads the fixed
    // id, finds the current text, and writes only the missing assignment.
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
