// skill-seed.test.ts — flair#2141 S2. The seed decision and its fail-closed
// orchestration, over an injected IO seam (no server).
import { describe, expect, it } from "bun:test";
import {
  decideSkillSeed,
  runSkillSeed,
  SEED_ASSIGNMENT_ID,
  SEED_SKILL_ID,
  type SeedAssignment,
  type SeedCurrent,
  type SeedRead,
  type SeedRowShape,
  type SkillSeedIo,
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
