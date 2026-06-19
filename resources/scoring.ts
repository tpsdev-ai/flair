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

// OPS-AYGD: bound the retrieval boost. RBOOST_CAP clamps the otherwise-unbounded
// log growth so a frequently-retrieved doc can't accumulate a runaway score
// advantage (the rich-get-richer feedback loop). RBOOST_RELEVANCE_FLOOR gates the
// boost in compositeScore so a popular-but-irrelevant doc isn't lifted into top-k
// for queries it doesn't semantically match. Both tuned against recall-eval.mjs.
export const RBOOST_CAP = 1.5;
export const RBOOST_RELEVANCE_FLOOR = 0.5;

export function retrievalBoost(retrievalCount: number): number {
  if (!retrievalCount || retrievalCount <= 0) return 1.0;
  return Math.min(1.0 + 0.1 * Math.log2(retrievalCount), RBOOST_CAP); // gentle, capped
}

export function compositeScore(
  semanticScore: number,
  record: { durability?: string; createdAt?: string; retrievalCount?: number; supersedes?: string },
): number {
  const durability = record.durability ?? "standard";
  const dWeight = DURABILITY_WEIGHTS[durability] ?? 0.7;
  const rFactor = record.createdAt ? recencyFactor(record.createdAt, durability) : 1.0;
  // OPS-AYGD: only apply the retrieval boost when the record is genuinely relevant to
  // this query (semanticScore clears the floor). Below the floor, a popular doc gets
  // no lift — kills the cross-query magnet while preserving boosts for relevant docs.
  const rBoost = semanticScore >= RBOOST_RELEVANCE_FLOOR ? retrievalBoost(record.retrievalCount ?? 0) : 1.0;
  return semanticScore * dWeight * rFactor * rBoost;
}
