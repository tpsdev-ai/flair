/**
 * migrations-stamp-outstanding.test.ts — corpus-derived outstanding
 * signal for embedding-stamp (flair#1073). Harper-free.
 */
import { describe, it, expect } from "bun:test";
import {
  EMBEDDING_STAMP_ID,
  countStampSpaces,
  describeStampOutstanding,
  resolveCurrentModelId,
  stampMigrationConverged,
} from "../../resources/migrations/stamp-outstanding.ts";

const CURRENT = "gguf:nomic-embed-text-v1.5-Q4_K_M+searchprefix";

describe("countStampSpaces", () => {
  it("treats a bare +searchprefix stamp as the same space as the qualified id", () => {
    const r = countStampSpaces(
      { "nomic-embed-text-v1.5-Q4_K_M+searchprefix": 40 },
      CURRENT,
    );
    expect(r.staleCount).toBe(0);
    expect(r.currentCount).toBe(40);
  });

  it("treats the pre-flip bare model id as STALE (the #1073 split)", () => {
    const r = countStampSpaces(
      {
        "nomic-embed-text-v1.5-Q4_K_M": 554,
        "nomic-embed-text-v1.5-Q4_K_M+searchprefix": 40,
      },
      CURRENT,
    );
    expect(r.staleCount).toBe(554);
    expect(r.currentCount).toBe(40);
    expect(r.staleStamps.some((s) => s.startsWith("nomic-embed-text-v1.5-Q4_K_M:"))).toBe(true);
  });

  it("ignores hash-fallback as a space", () => {
    const r = countStampSpaces({ "hash-512d": 3, [CURRENT]: 10 }, CURRENT);
    expect(r.staleCount).toBe(0);
    expect(r.currentCount).toBe(10);
  });
});

describe("describeStampOutstanding", () => {
  it("is not outstanding when the corpus is already current", () => {
    const r = describeStampOutstanding({
      modelCounts: { "nomic-embed-text-v1.5-Q4_K_M+searchprefix": 599 },
      currentModelId: CURRENT,
      migration: { id: EMBEDDING_STAMP_ID, state: "completed", rowsDone: 0, rowsRemaining: 0 },
      cyclePhase: "done",
    });
    expect(r.outstanding).toBe(false);
  });

  it("names embedding-stamp and the search+dedup consequences on a split corpus", () => {
    const r = describeStampOutstanding({
      modelCounts: {
        "nomic-embed-text-v1.5-Q4_K_M": 554,
        "nomic-embed-text-v1.5-Q4_K_M+searchprefix": 40,
      },
      currentModelId: CURRENT,
      migration: { id: EMBEDDING_STAMP_ID, state: "completed", rowsDone: 0, rowsRemaining: 0 },
      cyclePhase: "done",
    });
    expect(r.outstanding).toBe(true);
    if (!r.outstanding) throw new Error("expected outstanding");
    expect(r.warning).toContain(`migration '${EMBEDDING_STAMP_ID}' is outstanding`);
    expect(r.warning).toContain("554");
    expect(r.warning).toContain("cross-model search is unreliable");
    expect(r.warning).toContain("duplicate detection is inactive");
    expect(r.warning).toContain("marked it complete without converging");
    expect(r.warning).not.toContain("run: flair reembed");
  });

  it("names embedding-stamp on a uniformly pre-flip corpus (one space, not current)", () => {
    const r = describeStampOutstanding({
      modelCounts: { "nomic-embed-text-v1.5-Q4_K_M": 554 },
      currentModelId: CURRENT,
      cyclePhase: "done",
      migration: { id: EMBEDDING_STAMP_ID, state: "completed", rowsDone: 0, rowsRemaining: 0 },
    });
    expect(r.outstanding).toBe(true);
    if (!r.outstanding) throw new Error("expected outstanding");
    expect(r.staleCount).toBe(554);
    expect(r.warning).toContain(`migration '${EMBEDDING_STAMP_ID}' is outstanding`);
  });

  it("says the boot cycle never fired when cyclePhase is idle", () => {
    const r = describeStampOutstanding({
      modelCounts: { "nomic-embed-text-v1.5-Q4_K_M": 10, "nomic-embed-text-v1.5-Q4_K_M+searchprefix": 1 },
      currentModelId: CURRENT,
      cyclePhase: "idle",
    });
    expect(r.outstanding).toBe(true);
    if (!r.outstanding) throw new Error("expected outstanding");
    expect(r.warning).toContain("boot cycle never fired");
  });

  it("names this Harper process when the in-process audience has no cycle state", () => {
    const r = describeStampOutstanding({
      modelCounts: { "nomic-embed-text-v1.5-Q4_K_M": 10 },
      currentModelId: CURRENT,
    });
    expect(r.outstanding).toBe(true);
    if (!r.outstanding) throw new Error("expected outstanding");
    expect(r.warning).toContain("this process's next migration cycle");
    expect(r.warning).not.toContain("this CLI does not");
  });

  it("names the Harper process, not the CLI, for a client audience with no cycle state", () => {
    const r = describeStampOutstanding({
      modelCounts: { "nomic-embed-text-v1.5-Q4_K_M": 10 },
      currentModelId: CURRENT,
      audience: "client",
    });
    expect(r.outstanding).toBe(true);
    if (!r.outstanding) throw new Error("expected outstanding");
    expect(r.warning).toContain("the Harper process applies it on its next migration cycle");
    expect(r.warning).toContain("this CLI does not");
    expect(r.warning).not.toContain("this process's next migration cycle");
  });
});

describe("resolveCurrentModelId", () => {
  it("prefers an existing +searchprefix stamp so same-space bare/gguf pairing stays current", () => {
    expect(
      resolveCurrentModelId({
        "nomic-embed-text-v1.5-Q4_K_M+searchprefix": 40,
        "gguf:nomic-embed-text-v1.5-Q4_K_M+searchprefix": 60,
      }),
    ).toBe("gguf:nomic-embed-text-v1.5-Q4_K_M+searchprefix");
  });

  it("treats a uniformly pre-flip corpus as stale against +searchprefix", () => {
    expect(resolveCurrentModelId({ "nomic-embed-text-v1.5-Q4_K_M": 554 })).toBe(CURRENT);
    const r = describeStampOutstanding({
      modelCounts: { "nomic-embed-text-v1.5-Q4_K_M": 554 },
      currentModelId: resolveCurrentModelId({ "nomic-embed-text-v1.5-Q4_K_M": 554 }),
    });
    expect(r.outstanding).toBe(true);
  });
});

describe("stampMigrationConverged", () => {
  it("converges on a uniform current-space corpus", () => {
    const r = stampMigrationConverged({
      modelCounts: { "nomic-embed-text-v1.5-Q4_K_M+searchprefix": 599 },
      currentModelId: CURRENT,
      migration: { id: EMBEDDING_STAMP_ID, state: "completed" },
      cyclePhase: "done",
    });
    expect(r.converged).toBe(true);
  });

  it("does not converge on the #1073 split even if the runner said completed", () => {
    const r = stampMigrationConverged({
      modelCounts: {
        "nomic-embed-text-v1.5-Q4_K_M": 554,
        "nomic-embed-text-v1.5-Q4_K_M+searchprefix": 40,
      },
      currentModelId: CURRENT,
      migration: { id: EMBEDDING_STAMP_ID, state: "completed", rowsDone: 0, rowsRemaining: 0 },
      cyclePhase: "done",
    });
    expect(r.converged).toBe(false);
    expect(r.detail).toContain("outstanding");
  });

  it("does not converge while embedding-stamp is halted", () => {
    const r = stampMigrationConverged({
      modelCounts: { "nomic-embed-text-v1.5-Q4_K_M+searchprefix": 10 },
      currentModelId: CURRENT,
      migration: { id: EMBEDDING_STAMP_ID, state: "halted", reason: "blocked on disk" },
    });
    expect(r.converged).toBe(false);
    expect(r.detail).toContain("halted");
  });
});
