import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

/**
 * scorer-sync.test.ts — sync-check for scorer.ts's statsFor(), which is a
 * faithful hand-replication of test/bench/recall-harness/run.ts's own
 * (non-exported, so it can't be imported directly) statsFor(). This test
 * reads the harness source's raw text and asserts it still contains the
 * exact formula fragments scorer.ts replicated — a tripwire that fails
 * loudly if the harness's scoring math changes without this package being
 * updated to match, instead of silently drifting apart.
 */

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HARNESS_RUN_TS = join(PKG_ROOT, "..", "..", "test", "bench", "recall-harness", "run.ts");

describe("scorer.ts's statsFor stays in sync with run.ts's statsFor", () => {
  const harnessSource = readFileSync(HARNESS_RUN_TS, "utf8");

  test("run.ts still defines statsFor with the exact p@3 formula this package replicated", () => {
    expect(harnessSource).toContain("const hits3 = rows.filter(r => r.rank >= 0 && r.rank < 3).length;");
  });

  test("run.ts still defines statsFor with the exact MRR formula this package replicated", () => {
    expect(harnessSource).toContain("const rr = rows.reduce((s, r) => s + (r.rank >= 0 ? 1 / (r.rank + 1) : 0), 0);");
  });

  test("run.ts still returns the same {p3, mrr, n} shape from statsFor", () => {
    expect(harnessSource).toContain("return { p3: hits3 / rows.length, mrr: rr / rows.length, n: rows.length };");
  });

  test("run.ts still empty-guards statsFor identically to scorer.ts", () => {
    expect(harnessSource).toContain("if (!rows.length) return { p3: 0, mrr: 0, n: 0 };");
  });
});
