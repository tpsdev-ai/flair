/**
 * recall-metrics.test.ts — pure ranking-metric correctness for the shared
 * eval plumbing (packages/flair-bench/lib/metrics). Hand-computed expectations,
 * no I/O — a gate that scores CI recall floors has to be checkable by hand.
 */
import { describe, expect, test } from "bun:test";
import {
  recallAtK,
  ndcgAtK,
  reciprocalRank,
  scoreQuery,
  aggregate,
} from "../lib/index";

const RANKING = ["a", "b", "c", "d", "e"];

describe("recallAtK", () => {
  test("single relevant, hit@k semantics", () => {
    expect(recallAtK(RANKING, ["c"], 1)).toBe(0); // c is at index 2
    expect(recallAtK(RANKING, ["c"], 3)).toBe(1); // c in top 3
    expect(recallAtK(RANKING, ["a"], 1)).toBe(1);
  });
  test("multi-relevant = fraction of relevant set found in top-k", () => {
    expect(recallAtK(RANKING, ["b", "d"], 2)).toBe(0.5); // only b in top 2, of 2 relevant
    expect(recallAtK(RANKING, ["b", "d"], 5)).toBe(1);
  });
  test("edge cases score 0, never throw", () => {
    expect(recallAtK(RANKING, [], 5)).toBe(0);
    expect(recallAtK(RANKING, ["a"], 0)).toBe(0);
    expect(recallAtK([], ["a"], 5)).toBe(0);
  });
});

describe("ndcgAtK (binary gains)", () => {
  test("single relevant at rank 1 = 1.0", () => {
    expect(ndcgAtK(RANKING, ["a"], 10)).toBeCloseTo(1, 10);
  });
  test("single relevant at rank 3 = 1/log2(4) normalised by ideal 1", () => {
    // c at 0-based index 2 → 1/log2(2+2) = 0.5; idcg (1 relevant) = 1.
    expect(ndcgAtK(RANKING, ["c"], 10)).toBeCloseTo(0.5, 10);
  });
  test("two relevant, ideal-normalised", () => {
    // b@idx1 → 1/log2(3), d@idx3 → 1/log2(5); idcg = 1/log2(2) + 1/log2(3).
    const dcg = 1 / Math.log2(3) + 1 / Math.log2(5);
    const idcg = 1 / Math.log2(2) + 1 / Math.log2(3);
    expect(ndcgAtK(RANKING, ["b", "d"], 10)).toBeCloseTo(dcg / idcg, 10);
  });
  test("nothing relevant in top-k = 0; empty set = 0", () => {
    expect(ndcgAtK(RANKING, ["z"], 10)).toBe(0);
    expect(ndcgAtK(RANKING, [], 10)).toBe(0);
  });
});

describe("reciprocalRank", () => {
  test("1/rank of first relevant (1-based)", () => {
    expect(reciprocalRank(RANKING, ["c"])).toBeCloseTo(1 / 3, 10);
    expect(reciprocalRank(RANKING, ["d", "b"])).toBeCloseTo(1 / 2, 10); // first-seen is b at rank 2
  });
  test("miss = 0", () => {
    expect(reciprocalRank(RANKING, ["z"])).toBe(0);
    expect(reciprocalRank(RANKING, [])).toBe(0);
  });
});

describe("scoreQuery + aggregate", () => {
  test("scoreQuery reports the fixed ks", () => {
    const s = scoreQuery(RANKING, ["a"]);
    expect(s.recallAt1).toBe(1);
    expect(s.recallAt5).toBe(1);
    expect(s.recallAt10).toBe(1);
    expect(s.ndcgAt10).toBeCloseTo(1, 10);
    expect(s.reciprocalRank).toBe(1);
  });
  test("aggregate means each metric across queries", () => {
    const agg = aggregate([scoreQuery(RANKING, ["a"]), scoreQuery(RANKING, ["c"])]);
    expect(agg.nQueries).toBe(2);
    expect(agg.recallAt1).toBe(0.5); // 1 and 0
    expect(agg.mrr).toBeCloseTo((1 + 1 / 3) / 2, 10);
  });
  test("empty aggregate is 0/0, not a divide-by-zero", () => {
    const agg = aggregate([]);
    expect(agg.nQueries).toBe(0);
    expect(agg.recallAt1).toBe(0);
    expect(agg.mrr).toBe(0);
  });
});
