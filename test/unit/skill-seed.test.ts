// skill-seed.test.ts — flair#2141 S2. The seed decision and its fail-closed
// orchestration, over an injected IO seam (no Harper runtime).
import { describe, expect, it } from "bun:test";
import {
  decideSkillSeed,
  runSkillSeed,
  SEED_SKILL_AGENT_ID,
  SEED_SKILL_ID,
  seedSkillRows,
  type SeedAssignment,
  type SeedRowShape,
  type SkillSeedIo,
} from "../../resources/skill-seed.js";
import { usingFlairSkillHash } from "../../resources/using-flair-skill.js";

const CURRENT = "the current shipped text";
const CURRENT_HASH = usingFlairSkillHash(CURRENT);
const OLD = "an older shipped text";
const EDITED = "an operator edited this";

interface Fake extends SkillSeedIo {
  calls: { createRow: number; replaceRow: number; createAssignment: number };
}

function fakeIo(opts: {
  row: { ok: true; row: SeedRowShape | null } | { ok: false };
  assignments?: { ok: true; rows: SeedAssignment[] } | { ok: false };
}): Fake {
  const calls = { createRow: 0, replaceRow: 0, createAssignment: 0 };
  return {
    calls,
    readRow: async () => opts.row,
    readAssignments: async () => opts.assignments ?? { ok: true, rows: [] },
    createRow: async () => {
      calls.createRow += 1;
    },
    replaceRow: async () => {
      calls.replaceRow += 1;
    },
    createAssignment: async () => {
      calls.createAssignment += 1;
      return { id: "assign-1" };
    },
  };
}

const current = { name: "using-flair", content: CURRENT, hashes: [CURRENT_HASH, usingFlairSkillHash(OLD)], priority: "standard" };

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
  it("keeps an operator-edited row (its hash is not in the list)", () => {
    expect(decideSkillSeed(EDITED, CURRENT, current.hashes)).toBe("keep");
  });
});

describe("seedSkillRows", () => {
  it("keeps only the reserved system writer's rows", () => {
    const rows = [
      { id: "a", agentId: SEED_SKILL_AGENT_ID },
      { id: "b", agentId: "someone-else" },
      { id: "c" },
    ];
    expect(seedSkillRows(rows).map((r) => r.id)).toEqual(["a"]);
  });
});

describe("runSkillSeed", () => {
  it("creates the row and the org assignment when none exists", async () => {
    const io = fakeIo({ row: { ok: true, row: null } });
    const out = await runSkillSeed(io, current);
    expect(out).toMatchObject({ kind: "ok", action: "create", skillId: SEED_SKILL_ID, assignmentId: "assign-1" });
    expect(io.calls).toEqual({ createRow: 1, replaceRow: 0, createAssignment: 1 });
  });

  it("changes nothing on a re-run (unchanged) and does not duplicate the assignment", async () => {
    const io = fakeIo({
      row: { ok: true, row: { id: SEED_SKILL_ID, agentId: SEED_SKILL_AGENT_ID, content: CURRENT } },
      assignments: { ok: true, rows: [{ id: "assign-1", skillName: "using-flair" }] },
    });
    const out = await runSkillSeed(io, current);
    expect(out).toMatchObject({ kind: "ok", action: "unchanged", assignmentId: "assign-1" });
    expect(io.calls).toEqual({ createRow: 0, replaceRow: 0, createAssignment: 0 });
  });

  it("replaces an unedited shipped version", async () => {
    const io = fakeIo({ row: { ok: true, row: { id: SEED_SKILL_ID, agentId: SEED_SKILL_AGENT_ID, content: OLD } } });
    const out = await runSkillSeed(io, current);
    expect(out).toMatchObject({ kind: "ok", action: "replace" });
    expect(io.calls.replaceRow).toBe(1);
    expect(io.calls.createRow).toBe(0);
  });

  it("keeps an operator-edited row and reports it", async () => {
    const io = fakeIo({ row: { ok: true, row: { id: SEED_SKILL_ID, agentId: SEED_SKILL_AGENT_ID, content: EDITED } } });
    const out = await runSkillSeed(io, current);
    expect(out).toMatchObject({ kind: "ok", action: "keep" });
    expect((out as { message: string }).message).toContain("operator");
    // the row is untouched; the assignment is still ensured
    expect(io.calls).toEqual({ createRow: 0, replaceRow: 0, createAssignment: 1 });
  });

  it("refuses when the existing row cannot be read, and writes nothing", async () => {
    const io = fakeIo({ row: { ok: false } });
    const out = await runSkillSeed(io, current);
    expect(out).toMatchObject({ kind: "refused", error: "skill_seed_read_failed" });
    expect(io.calls).toEqual({ createRow: 0, replaceRow: 0, createAssignment: 0 });
  });

  it("refuses when the existing assignment cannot be read, and writes nothing", async () => {
    const io = fakeIo({ row: { ok: true, row: null }, assignments: { ok: false } });
    const out = await runSkillSeed(io, current);
    expect(out).toMatchObject({ kind: "refused", error: "skill_seed_read_failed" });
    expect(io.calls).toEqual({ createRow: 0, replaceRow: 0, createAssignment: 0 });
  });

  it("refuses when the id is owned by something other than the seed", async () => {
    const io = fakeIo({ row: { ok: true, row: { id: SEED_SKILL_ID, agentId: "someone-else", content: EDITED } } });
    const out = await runSkillSeed(io, current);
    expect(out).toMatchObject({ kind: "refused", error: "skill_seed_id_conflict" });
    expect(io.calls).toEqual({ createRow: 0, replaceRow: 0, createAssignment: 0 });
  });
});
