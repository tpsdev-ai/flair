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
// the correct docs). Bounded to a gentle nudge that breaks near-ties without
// overriding a clear semantic winner. Tuned offline against the real corpus
// (floor 0.5 + cap 1.1 → composite p@3 recovers to 1.00, magnet eliminated).
// A query-relative tie-breaker gate (boost only within ~0.05 of the top raw score)
// is the principled follow-up for graduated boosting; it needs the search loop to
// pass the candidate-set top score, so it's deferred to its own change.
export const RBOOST_CAP = 1.1; // max +10% — a tie-breaker, not an override
export const RBOOST_RELEVANCE_FLOOR = 0.5; // no boost at all for clearly-irrelevant docs

export function retrievalBoost(retrievalCount: number): number {
  if (!retrievalCount || retrievalCount <= 0) return 1.0;
  return Math.min(1.0 + 0.1 * Math.log2(retrievalCount), RBOOST_CAP); // gentle, capped
}

// flair#623 (2026-07-08): SemanticSearch.ts's `scoring` param now DEFAULTS to
// "raw" — compositeScore measurably HURTS recall-eval precision on the live
// corpus (Δp@3 -0.38 to -0.50 vs raw). Unlike rBoost above, dWeight and rFactor
// apply UNCONDITIONALLY — no relevance-floor gate — so they can (and do) sink a
// clearly-best semantic/BM25 match below a `permanent`/fresh but weaker match.
// compositeScore itself is UNCHANGED here; it's still opt-in via scoring:
// "composite" for callers who want durability/recency-aware re-ranking. If this
// formula ever gets a relevance-gated dWeight/rFactor (the rBoost-style fix),
// re-run recall-eval.mjs before reconsidering the default.
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
