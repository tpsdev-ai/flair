/**
 * Predicates for the BM25 hit-tracking fixture (flair#1569).
 *
 * #1565's warmup treated `index.state === "ready" && counterTotal >= 5` as
 * "the index can serve the written rows." That is not sufficient:
 *   - ready can land after a partial corpus scan (size << written rows)
 *   - counterTotal is a sum, so five hits on one id look like a full set
 *
 * Measured arms assert 64 five-hit searches of metadata-0000..0004. Start
 * those only when the index holds the written corpus and every tracked id
 * has a committed MemoryHitStat.
 */

export function lexicalIndexServesCorpus(
  index: { state?: string; size?: number } | null | undefined,
  expectedSize: number,
): boolean {
  return index?.state === "ready" && (index.size ?? 0) >= expectedSize;
}

export function trackedHitStatsCommitted(
  counts: readonly number[] | null | undefined,
  expectedIds: number,
): boolean {
  if (!counts || counts.length < expectedIds) return false;
  for (let i = 0; i < expectedIds; i++) {
    if ((counts[i] ?? 0) < 1) return false;
  }
  return true;
}

export function trackedResultSet(ids: readonly string[], expectedIds: readonly string[]): boolean {
  return ids.length === expectedIds.length && expectedIds.every((id) => ids.includes(id));
}

/** True when the BM25 leg (not fused top-k) already contains every tracked id. */
export function bm25LegServesTracked(
  legs: { bm25?: string[] } | null | undefined,
  expectedIds: readonly string[],
): boolean {
  const bm25 = legs?.bm25 ?? [];
  return expectedIds.every((id) => bm25.includes(id));
}
