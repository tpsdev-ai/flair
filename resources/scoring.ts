// ─── Temporal Decay + Relevance Scoring ─────────────────────────────────────
// Pure scoring functions extracted from SemanticSearch.ts (OPS-AYGD) so they can
// be unit-tested directly. Importing SemanticSearch.ts pulls in the Harper runtime
// (storage init) and can't run outside a live Harper; this module has no Harper
// dependency, so test/unit/temporal-scoring.test.ts exercises the real shipped code.

export const DURABILITY_WEIGHTS: Record<string, number> = {
  permanent: 1.0,
  persistent: 0.9,
  standard: 0.7,
  ephemeral: 0.4,
};

// Half-life in days for exponential decay per durability level
export const DECAY_HALF_LIFE_DAYS: Record<string, number> = {
  permanent: Infinity, // never decays
  persistent: 90,
  standard: 30,
  ephemeral: 7,
};

export function recencyFactor(createdAt: string, durability: string): number {
  const halfLife = DECAY_HALF_LIFE_DAYS[durability] ?? 30;
  if (halfLife === Infinity) return 1.0;
  const ageDays = (Date.now() - Date.parse(createdAt)) / (1000 * 60 * 60 * 24);
  const lambda = Math.LN2 / halfLife;
  return Math.exp(-lambda * ageDays);
}

// OPS-AYGD: the retrieval boost was unbounded and OVERRODE semantic ranking —
// recall-eval 2026-06-19 showed composite p@3 0.83 vs raw 1.00, with a popular doc
// magnetised into 5/6 queries (its rBoost lifted a 0.55-0.65 semantic score above
// the correct docs). The absolute relevance floor (0.5) + cap (1.1) from #493
// eliminated the magnet but flattened the boost to nearly binary.
//
// The principled fix: a QUERY-RELATIVE tie-breaker — only boost a doc whose
// semantic score is within RBOOST_RELEVANCE_DELTA of the TOP raw score in the
// candidate set. This lets the boost break genuine near-ties (where the embedding
// cannot separate docs) while never overriding a clear semantic winner, and
// restores graduated boosting (cap 1.5 instead of binary 1.1).
//
// Tuned offline by Flint against the real corpus: relDelta 0.05 with cap 1.5
// gives composite p@3 1.00 with the magnet eliminated.
export const RBOOST_CAP = 1.5; // max +50% — graduated boost
export const RBOOST_RELEVANCE_DELTA = 0.05; // only boost docs within delta of top raw score

export function retrievalBoost(retrievalCount: number): number {
  if (!retrievalCount || retrievalCount <= 0) return 1.0;
  return Math.min(1.0 + 0.1 * Math.log2(retrievalCount), RBOOST_CAP);
}

export function compositeScore(
  semanticScore: number,
  record: { durability?: string; createdAt?: string; retrievalCount?: number; supersedes?: string },
  topScore: number = semanticScore,
): number {
  const durability = record.durability ?? "standard";
  const dWeight = DURABILITY_WEIGHTS[durability] ?? 0.7;
  const rFactor = record.createdAt ? recencyFactor(record.createdAt, durability) : 1.0;
  // OPS-AYGD relative tie-breaker: only boost a doc whose semantic score is
  // within RBOOST_RELEVANCE_DELTA of the top raw score in the candidate set.
  // Default topScore = semanticScore keeps ungated callers boosting (backward
  // compatible — a doc is always within delta of itself).
  const eligible = semanticScore >= topScore - RBOOST_RELEVANCE_DELTA;
  const rBoost = eligible ? retrievalBoost(record.retrievalCount ?? 0) : 1.0;
  return semanticScore * dWeight * rFactor * rBoost;
}
