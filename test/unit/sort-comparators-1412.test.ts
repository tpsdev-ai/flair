/**
 * sort-comparators-1412.test.ts — input-order independence for the #1412
 * comparator family.
 *
 * The defect: a stable sort on one key keeps input order on ties, and that
 * input order is Harper scan order (free to change across restarts). The
 * powered check is exactly that property: the same result set, two input
 * orders, identical output. A restart-based test would catch the same
 * thing indirectly; this one names it.
 *
 * One describe per comparator. The byRecencyThenId fixture has real ties
 * (equal `_rank`, differing `createdAt` / `id`) and asserts newer
 * `createdAt` wins. Null `createdAt` is oldest, never NaN.
 */
import { describe, test, expect } from "bun:test";
import {
  compareKey,
  byNumberDescThenId,
  byRecencyThenId,
} from "../../resources/sort-comparators.ts";

function ids<T extends { id: string }>(rows: T[]): string[] {
  return rows.map((r) => r.id);
}

function sortCopy<T>(rows: T[], cmp: (a: T, b: T) => number): T[] {
  return [...rows].sort(cmp);
}

describe("byNumberDescThenId — score/rank descending, then id ASC", () => {
  const byScore = byNumberDescThenId<{ id: string; score: number }>((r) => r.score);
  // Real ties: equal score, differing id. Plus one strictly-higher score
  // so the primary key still dominates.
  const fixture = [
    { id: "zzz", score: 0.5 },
    { id: "aaa", score: 0.5 },
    { id: "mmm", score: 0.9 },
    { id: "nnn", score: 0.5 },
  ];

  test("the same set in two input orders ranks identically, high score first, ties by id ASC", () => {
    const expected = ["mmm", "aaa", "nnn", "zzz"];
    const forward = sortCopy(fixture, byScore);
    const reversed = sortCopy([...fixture].reverse(), byScore);
    expect(ids(forward)).toEqual(expected);
    expect(ids(reversed)).toEqual(expected);
  });
});

describe("byRecencyThenId — createdAt DESC (null→oldest) then id ASC", () => {
  // Equal `_rank` (the line-579 primary key), differing createdAt / id.
  // This is the fixture the #1412 spec names: a test that seeded unequal
  // `_rank` would pass vacuously on the recency tail.
  const fixture = [
    { id: "old-z", _rank: 1, createdAt: "2024-01-01T00:00:00.000Z" },
    { id: "new-m", _rank: 1, createdAt: "2024-06-01T00:00:00.000Z" },
    { id: "old-a", _rank: 1, createdAt: "2024-01-01T00:00:00.000Z" },
    { id: "null-b", _rank: 1, createdAt: null },
    { id: "missing-c", _rank: 1 },
  ];
  const retrievalCmp = (
    a: (typeof fixture)[number],
    b: (typeof fixture)[number],
  ) => (b._rank - a._rank) || byRecencyThenId(a, b);

  test("two input orders are identical, newer createdAt wins, null is oldest, id ASC on a createdAt tie", () => {
    const expected = ["new-m", "old-a", "old-z", "missing-c", "null-b"];
    const forward = sortCopy(fixture, retrievalCmp);
    const reversed = sortCopy([...fixture].reverse(), retrievalCmp);
    expect(ids(forward)).toEqual(expected);
    expect(ids(reversed)).toEqual(ids(forward));
    expect(forward[0].createdAt).toBe("2024-06-01T00:00:00.000Z");
  });

  test("never returns NaN — including null / missing createdAt", () => {
    type Row = { id: string; createdAt?: string | null };
    const a: Row = { id: "a", createdAt: null };
    const b: Row = { id: "b" };
    const c: Row = { id: "c", createdAt: "2024-01-01T00:00:00.000Z" };
    expect(Number.isNaN(byRecencyThenId(a, b))).toBe(false);
    expect(Number.isNaN(byRecencyThenId(a, c))).toBe(false);
    expect(Number.isNaN(byRecencyThenId(b, c))).toBe(false);
  });
});

describe("compareKey — generic tail (unusual keys still get the backstop)", () => {
  // Cosine's shape: score DESC, then corpus `.index` ASC — not `.id`.
  const byScoreThenIndex = (
    a: { index: number; score: number },
    b: { index: number; score: number },
  ) => (b.score - a.score) || compareKey(a.index, b.index);

  const fixture = [
    { index: 4, score: 0.8 },
    { index: 1, score: 0.8 },
    { index: 3, score: 0.9 },
    { index: 2, score: 0.8 },
  ];

  test("the same scored rows in two input orders rank identically; ties break on index ASC", () => {
    const expected = [3, 1, 2, 4];
    const forward = sortCopy(fixture, byScoreThenIndex).map((r) => r.index);
    const reversed = sortCopy([...fixture].reverse(), byScoreThenIndex).map((r) => r.index);
    expect(forward).toEqual(expected);
    expect(reversed).toEqual(expected);
  });
});
