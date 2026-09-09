/**
 * search-index-ready.test.ts — flair#1569.
 *
 * The #1565 warmup (`index.state === "ready" && counterTotal >= 5`) is the
 * hole this helper exists to close. Drive the shipped predicates; no Harper.
 */
import { describe, expect, test } from "bun:test";
import {
  lexicalIndexServesCorpus,
  trackedHitStatsCommitted,
  trackedResultSet,
  bm25LegServesTracked,
  hnswLegServesTracked,
} from "../helpers/search-index-ready.ts";

describe("lexicalIndexServesCorpus", () => {
  test("ready is not enough without the written corpus size", () => {
    expect(lexicalIndexServesCorpus({ state: "ready", size: 3 }, 1000)).toBe(false);
    expect(lexicalIndexServesCorpus({ state: "ready", size: 999 }, 1000)).toBe(false);
    expect(lexicalIndexServesCorpus({ state: "ready", size: 1000 }, 1000)).toBe(true);
    expect(lexicalIndexServesCorpus({ state: "ready", size: 1001 }, 1000)).toBe(true);
  });

  test("building or empty never counts as serving, even at full size", () => {
    expect(lexicalIndexServesCorpus({ state: "building", size: 1000 }, 1000)).toBe(false);
    expect(lexicalIndexServesCorpus({ state: "empty", size: 0 }, 1000)).toBe(false);
    expect(lexicalIndexServesCorpus({ state: "disabled", size: 1000 }, 1000)).toBe(false);
    expect(lexicalIndexServesCorpus(undefined, 1000)).toBe(false);
    expect(lexicalIndexServesCorpus({ state: "ready" }, 1000)).toBe(false);
  });
});

describe("trackedHitStatsCommitted", () => {
  test("summed counterTotal >= 5 is not committed-for-all-ids", () => {
    expect(trackedHitStatsCommitted([5, 0, 0, 0, 0], 5)).toBe(false);
    expect(trackedHitStatsCommitted([3, 2, 0, 0, 0], 5)).toBe(false);
    expect(trackedHitStatsCommitted([1, 1, 1, 1], 5)).toBe(false);
    expect(trackedHitStatsCommitted([1, 1, 1, 1, 1], 5)).toBe(true);
    expect(trackedHitStatsCommitted([2, 1, 4, 1, 8], 5)).toBe(true);
  });

  test("rejects missing or short ledgers", () => {
    expect(trackedHitStatsCommitted(undefined, 5)).toBe(false);
    expect(trackedHitStatsCommitted([], 5)).toBe(false);
    expect(trackedHitStatsCommitted([0, 0, 0, 0, 0], 5)).toBe(false);
  });
});

describe("trackedResultSet", () => {
  const expected = ["metadata-0000", "metadata-0001", "metadata-0002", "metadata-0003", "metadata-0004"];

  test("requires the full tracked set, not a partial hybrid recall", () => {
    expect(trackedResultSet(expected, expected)).toBe(true);
    expect(trackedResultSet([...expected].reverse(), expected)).toBe(true);
    expect(trackedResultSet(["metadata-0000", "metadata-0001", "metadata-0002"], expected)).toBe(false);
    expect(trackedResultSet([...expected, "metadata-0005"], expected)).toBe(false);
    expect(trackedResultSet(["metadata-0005", "metadata-0006", "metadata-0007", "metadata-0008", "metadata-0009"], expected)).toBe(false);
  });
});

describe("bm25LegServesTracked", () => {
  const expected = ["metadata-0000", "metadata-0001", "metadata-0002", "metadata-0003", "metadata-0004"];

  test("fused top-k can miss ids that the BM25 leg already serves", () => {
    expect(bm25LegServesTracked({ bm25: expected }, expected)).toBe(true);
    expect(bm25LegServesTracked({
      bm25: expected,
    }, expected)).toBe(true);
    expect(bm25LegServesTracked({
      bm25: ["metadata-0000", "metadata-0001", "metadata-0002", "metadata-0311", "metadata-0312"],
    }, expected)).toBe(false);
    expect(bm25LegServesTracked(undefined, expected)).toBe(false);
    expect(bm25LegServesTracked({ bm25: [] }, expected)).toBe(false);
  });
});

describe("hnswLegServesTracked", () => {
  const expected = ["metadata-0000", "metadata-0001", "metadata-0002", "metadata-0003", "metadata-0004"];

  test("a sequential HNSW page is not the tracked lexical set", () => {
    expect(hnswLegServesTracked({ hnsw: expected }, expected)).toBe(true);
    expect(hnswLegServesTracked({
      hnsw: ["metadata-0005", "metadata-0006", "metadata-0007", "metadata-0008", "metadata-0009"],
    }, expected)).toBe(false);
    expect(hnswLegServesTracked({ hnsw: ["metadata-0000", "metadata-0001", "metadata-0002"] }, expected)).toBe(false);
  });
});
