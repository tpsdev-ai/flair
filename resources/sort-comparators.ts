/**
 * Deterministic sort comparators (flair#1412).
 *
 * Retrieval and selection sorts used to key on one number (score, rank,
 * priority) and then inherit `Array.prototype.sort`'s input order on ties.
 * That input order is Harper scan order, which is free to change across
 * restarts. The family below makes the tie-break the default thing to
 * reach for: each helper has its own primary key, and they share the
 * `compareKey` tail — not one comparator forced onto every site.
 *
 * Do not collapse this into a single `byScoreThenId`. cosine.ts keys on
 * corpus `.index`; MemoryBootstrap (flair#1409, not this PR) keys on the
 * soul `key`. The shared part is the tail.
 *
 * Locale-independent: `compareKey` is code-unit / numeric `<`/`>`, never
 * `localeCompare`. ISO-8601 UTC strings compare chronologically that way.
 */

/** Total-order tail. Works for ids, corpus indexes, soul keys. */
export function compareKey<T extends string | number>(a: T, b: T): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Score / rank descending, then `id` ascending. */
export function byNumberDescThenId<T extends { id: string }>(
  getNumber: (row: T) => number,
): (a: T, b: T) => number {
  return (a, b) => (getNumber(b) - getNumber(a)) || compareKey(a.id, b.id);
}

/**
 * `createdAt` DESC (null → oldest, never NaN) then `id` ASC.
 *
 * Determinism comes from `id` ASC — ids are unique, so this is a total
 * order no matter what `createdAt` does. Do not date-arithmetic a
 * possibly-null field: `new Date(null).getTime()` is 0, but subtracting
 * NaN (unparseable / missing-after-coercion) is undefined behaviour for
 * `Array.prototype.sort`. Empty-string fallback keeps the comparison in
 * string space; an empty value is less than any ISO-8601 UTC timestamp,
 * so it sorts last under DESC.
 *
 * Clock-skew caveat: `createdAt` is writer-stamped. Across federated
 * writers this is best-effort recency within an exact `_rank` tie, not a
 * correctness claim. Skew can misorder rows the ranker already called
 * equivalent; it cannot reintroduce nondeterminism, because `id` ASC
 * still resolves every remaining tie.
 */
export function byRecencyThenId<T extends { id: string; createdAt?: string | null }>(
  a: T,
  b: T,
): number {
  return compareKey(b.createdAt ?? "", a.createdAt ?? "") || compareKey(a.id, b.id);
}
