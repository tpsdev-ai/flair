import { describe, test, expect } from "bun:test";
import { statsFor, scoreRows, type ScoredRow } from "../src/scorer.js";

describe("statsFor", () => {
  test("empty rows -> all zero, n=0", () => {
    expect(statsFor([])).toEqual({ p3: 0, mrr: 0, n: 0 });
  });

  test("all top-1 hits -> p3=1, mrr=1", () => {
    const rows = [{ rank: 0 }, { rank: 0 }, { rank: 0 }];
    expect(statsFor(rows)).toEqual({ p3: 1, mrr: 1, n: 3 });
  });

  test("known mixed fixture matches hand-calculated p@3/MRR", () => {
    // ranks: 0 (hit, rr=1), 1 (hit, rr=0.5), 2 (hit, rr=1/3), 3 (miss top-3, rr=0.25), -1 (not found, rr=0)
    const rows = [{ rank: 0 }, { rank: 1 }, { rank: 2 }, { rank: 3 }, { rank: -1 }];
    const result = statsFor(rows);
    // hits3 = 3 of 5 -> p3 = 0.6
    expect(result.p3).toBeCloseTo(0.6, 10);
    // mrr = (1 + 0.5 + 1/3 + 0.25 + 0) / 5
    const expectedMrr = (1 + 0.5 + 1 / 3 + 0.25 + 0) / 5;
    expect(result.mrr).toBeCloseTo(expectedMrr, 10);
    expect(result.n).toBe(5);
  });

  test("rank=-1 (not found) contributes 0 to both p3 and mrr, never negative", () => {
    const rows = [{ rank: -1 }, { rank: -1 }];
    expect(statsFor(rows)).toEqual({ p3: 0, mrr: 0, n: 2 });
  });

  test("rank exactly 3 (0-based, 4th place) is NOT a p@3 hit but contributes to MRR", () => {
    const rows = [{ rank: 3 }];
    const result = statsFor(rows);
    expect(result.p3).toBe(0);
    expect(result.mrr).toBeCloseTo(0.25, 10);
  });
});

describe("scoreRows (per-kind breakdown)", () => {
  test("splits by kind and computes independent stats per kind", () => {
    const rows: ScoredRow[] = [
      { rank: 0, kind: "clean" },
      { rank: 0, kind: "clean" },
      { rank: -1, kind: "trap" },
      { rank: 5, kind: "hard" },
      { rank: 0, kind: "stress" },
    ];
    const { aggregate, perKind } = scoreRows(rows);
    expect(aggregate.n).toBe(5);
    expect(perKind.clean).toEqual({ p3: 1, mrr: 1, n: 2 });
    expect(perKind.trap).toEqual({ p3: 0, mrr: 0, n: 1 });
    expect(perKind.hard.n).toBe(1);
    expect(perKind.hard.p3).toBe(0);
    expect(perKind.stress).toEqual({ p3: 1, mrr: 1, n: 1 });
  });

  test("a kind with zero rows reports n=0, p3=0, mrr=0 (not NaN)", () => {
    const rows: ScoredRow[] = [{ rank: 0, kind: "clean" }];
    const { perKind } = scoreRows(rows);
    expect(perKind.stress).toEqual({ p3: 0, mrr: 0, n: 0 });
    expect(Number.isNaN(perKind.stress.p3)).toBe(false);
  });
});
