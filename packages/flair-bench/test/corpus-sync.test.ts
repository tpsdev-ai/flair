import { describe, test, expect } from "bun:test";

/**
 * corpus-sync.test.ts — the sync-check for src/corpus-v2.ts (see that
 * file's header and scripts/sync-corpus.mjs). flair-bench ships a
 * build-time COPY of the flair recall-eval harness's corpus-v2.ts (it can't
 * import test/bench/ at runtime from a published standalone package — see
 * src/corpus-v2.ts's header). This test is what keeps that copy honest: it
 * imports BOTH modules directly (works because this test only runs inside
 * the monorepo checkout, where test/bench/recall-harness/corpus-v2.ts is
 * present at the relative path below) and deep-equals their exported
 * CORPUS/QUERIES arrays. A change to the harness corpus that isn't synced
 * here fails this test loudly instead of silently drifting.
 */

const copy = await import("../src/corpus-v2.js");
const source = await import("../../../test/bench/recall-harness/corpus-v2.js");

describe("src/corpus-v2.ts stays in sync with the harness source", () => {
  test("CORPUS is byte-for-byte (deep-equal) identical", () => {
    expect(copy.CORPUS).toEqual(source.CORPUS);
  });

  test("QUERIES is byte-for-byte (deep-equal) identical", () => {
    expect(copy.QUERIES).toEqual(source.QUERIES);
  });

  test("record/query counts match the documented instrument shape (251 records, 126 queries)", () => {
    expect(copy.CORPUS.length).toBe(251);
    expect(copy.QUERIES.length).toBe(126);
  });
});
