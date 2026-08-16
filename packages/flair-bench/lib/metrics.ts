/**
 * metrics.ts — pure ranking metrics for the deterministic recall eval.
 *
 * No I/O, no Harper, no corpus knowledge — given a retrieved ranking and a set
 * of KNOWN-relevant ids, compute recall@k, nDCG@k, and reciprocal rank. Kept
 * pure so the numbers are unit-testable against hand-checked rankings without
 * spawning anything (a metric you can't check by hand is a metric you can't
 * trust to gate CI).
 *
 * Relevance is a SET per query. Layer 1's curated corpus labels one relevant
 * memory per query (so recall@k degrades to hit@k, nDCG to 1/log2(rank+1)
 * normalised, MRR to 1/rank) — but the SET signature is what lets Layer 2 reuse
 * these unchanged when a LongMemEval question has several relevant memories.
 *
 * Binary relevance only (relevant or not) — LongMemEval and this corpus both
 * label membership, not graded gains. If graded relevance is ever needed, add a
 * gains map here rather than teaching every call site a second scale.
 */

function toSet(relevant: Iterable<string>): Set<string> {
  return relevant instanceof Set ? relevant : new Set(relevant);
}

/**
 * recall@k = |relevant ∩ top-k| / |relevant|.
 * With one relevant id this is hit@k (1 if it's in the top k, else 0).
 * Returns 0 for an empty relevant set (nothing to recall) — a caller that
 * treats "no labels" as a real 0.0 has a corpus bug, not a recall result.
 */
export function recallAtK(rankedIds: string[], relevant: Iterable<string>, k: number): number {
  const rel = toSet(relevant);
  if (rel.size === 0) return 0;
  if (k <= 0) return 0;
  const topK = rankedIds.slice(0, k);
  let hits = 0;
  for (const id of topK) if (rel.has(id)) hits++;
  return hits / rel.size;
}

/**
 * nDCG@k with binary gains. DCG = Σ_{i in top-k, relevant} 1/log2(i+2) where i
 * is the 0-based rank position (so rank 0 → 1/log2(2) = 1). IDCG is the DCG of
 * the ideal ranking (all relevants packed at the top, capped at k). Returns 0
 * when nothing relevant appears in the top k, and for an empty relevant set.
 */
export function ndcgAtK(rankedIds: string[], relevant: Iterable<string>, k: number): number {
  const rel = toSet(relevant);
  if (rel.size === 0 || k <= 0) return 0;
  const topK = rankedIds.slice(0, k);
  let dcg = 0;
  for (let i = 0; i < topK.length; i++) {
    if (rel.has(topK[i]!)) dcg += 1 / Math.log2(i + 2);
  }
  const idealHits = Math.min(rel.size, k);
  let idcg = 0;
  for (let i = 0; i < idealHits; i++) idcg += 1 / Math.log2(i + 2);
  return idcg === 0 ? 0 : dcg / idcg;
}

/**
 * Reciprocal rank of the FIRST relevant id (1/rank, rank 1-based). 0 if no
 * relevant id appears anywhere in the ranking. Mean over queries = MRR.
 */
export function reciprocalRank(rankedIds: string[], relevant: Iterable<string>): number {
  const rel = toSet(relevant);
  if (rel.size === 0) return 0;
  for (let i = 0; i < rankedIds.length; i++) {
    if (rel.has(rankedIds[i]!)) return 1 / (i + 1);
  }
  return 0;
}

export interface PerQueryScore {
  recallAt1: number;
  recallAt5: number;
  recallAt10: number;
  ndcgAt10: number;
  reciprocalRank: number;
}

export interface AggregateScore {
  recallAt1: number;
  recallAt5: number;
  recallAt10: number;
  ndcgAt10: number;
  mrr: number;
  nQueries: number;
}

/** Score one query's ranking against its relevant set at the fixed ks the
 *  Layer 1 eval reports (1/5/10, nDCG@10). */
export function scoreQuery(rankedIds: string[], relevant: Iterable<string>): PerQueryScore {
  return {
    recallAt1: recallAtK(rankedIds, relevant, 1),
    recallAt5: recallAtK(rankedIds, relevant, 5),
    recallAt10: recallAtK(rankedIds, relevant, 10),
    ndcgAt10: ndcgAtK(rankedIds, relevant, 10),
    reciprocalRank: reciprocalRank(rankedIds, relevant),
  };
}

/** Mean each metric across per-query scores. Empty input → all zeros with
 *  nQueries 0 (a caller must treat that as "no eval ran", not a real floor
 *  breach). */
export function aggregate(perQuery: PerQueryScore[]): AggregateScore {
  const n = perQuery.length;
  if (n === 0) return { recallAt1: 0, recallAt5: 0, recallAt10: 0, ndcgAt10: 0, mrr: 0, nQueries: 0 };
  const sum = perQuery.reduce(
    (a, s) => ({
      recallAt1: a.recallAt1 + s.recallAt1,
      recallAt5: a.recallAt5 + s.recallAt5,
      recallAt10: a.recallAt10 + s.recallAt10,
      ndcgAt10: a.ndcgAt10 + s.ndcgAt10,
      reciprocalRank: a.reciprocalRank + s.reciprocalRank,
    }),
    { recallAt1: 0, recallAt5: 0, recallAt10: 0, ndcgAt10: 0, reciprocalRank: 0 },
  );
  return {
    recallAt1: sum.recallAt1 / n,
    recallAt5: sum.recallAt5 / n,
    recallAt10: sum.recallAt10 / n,
    ndcgAt10: sum.ndcgAt10 / n,
    mrr: sum.reciprocalRank / n,
    nQueries: n,
  };
}
