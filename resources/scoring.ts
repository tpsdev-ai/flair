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

// ─── usageBoost — the verified-USE signal (flair#683) ───────────────────────
// retrievalCount/retrievalBoost above count a search HIT as "used" — a
// rich-get-richer loop root-caused in #623 (a doc that surfaces once gets
// boosted, surfaces more, boosts more, independent of whether it was ever
// actually useful). usageCount is a STRONGER, distinct signal: it is only
// ever incremented by the dedicated usage-feedback endpoint (resources/
// MemoryUsage.ts) when a caller explicitly reports that a memory was
// cited/used to ground an answer or decision — never auto-incremented on
// search (schemas/memory.graphql's usageCount field doc). Dedup'd
// (agent, memory) ≤ 1 contribution and rate-limited there, so this function
// only ever sees a bounded, deliberately-reported count.
//
// SAME shape as retrievalBoost — a gentle, capped nudge (a tie-breaker, never
// an override), floor-gated so a popular-but-irrelevant doc gets no lift.
// K&S verdict (FLAIR-USAGE-FEEDBACK-SIGNAL.md, 2026-07-11): keep the
// constants/shape identical to retrievalBoost's so the ONLY variable in the
// harness rematch (test/bench/recall-harness) is signal QUALITY (what gets
// counted), not magnitude/shape — that isolation is what makes the
// positive/negative/noise comparison meaningful.
export const USAGE_BOOST_CAP = 1.1; // max +10% — a tie-breaker, not an override
export const USAGE_RELEVANCE_FLOOR = 0.5; // no boost at all for clearly-irrelevant docs

export function usageBoost(usageCount: number): number {
  if (!usageCount || usageCount <= 0) return 1.0;
  return Math.min(1.0 + 0.1 * Math.log2(usageCount), USAGE_BOOST_CAP); // gentle, capped
}

// flair#623 (2026-07-08): SemanticSearch.ts's `scoring` param now DEFAULTS to
// "raw" — compositeScore measurably HURTS recall-eval precision on the live
// corpus (Δp@3 -0.38 to -0.50 vs raw). recall-harness's harder 87-record
// corpus (test/bench/recall-harness) reproduced this in isolation at Δp@3
// -0.900: dWeight and rFactor applied UNCONDITIONALLY — no relevance-floor
// gate, unlike rBoost above — so an unrelated-but-`permanent`/fresh record
// (dWeight=1.0 × rFactor=1.0, no discount at all) routinely outranked the
// objectively best match once its `standard`/`persistent`, weeks-old
// durability/recency discount cut 30-95% off its score.
//
// FIRST ATTEMPT (kept here as a documented dead end — do not re-introduce):
// gate dWeight×rFactor by ramping it from neutral-at-floor to
// full-strength-at-rawScore=1.0, mirroring rBoost's floor gate. Measured
// WORSE than the original bug (p@3 0.033 vs 0.067) on recall-harness. Root
// cause: the records compositeScore actually needs to protect are the
// GENUINELY relevant ones, and a genuine match has a HIGH rawScore (0.9+ on
// this corpus, not near the 0.5 floor) — so ramping the gate open as
// rawScore rises means the *correct* answer gets the discount at nearly full
// strength (gate≈1), while the discount was already a no-op for the
// magnet distractors (permanent/fresh ⇒ dWeight×rFactor=1.0 regardless of any
// gate). Ramping-by-relevance is backwards for a DISCOUNT-only multiplier: it
// protects weak/borderline matches that were never the problem, and does
// nothing for the strong matches that were.
//
// THE ACTUAL FIX: treat dWeight×rFactor the same way RBOOST_CAP treats
// retrievalBoost — bound it to a small band around 1.0 (a gentle nudge, not
// an override) via COMPOSITE_DISCOUNT_FLOOR, so durability/recency can never
// cost a record more than a fixed, small percentage regardless of how stale
// or low-durability it is. The RBOOST_RELEVANCE_FLOOR-style gate is layered
// on top per its original intent (no adjustment at all for records that
// don't even clear a basic relevance bar) but the CAP is what actually stops
// the magnet: even a `standard`/95-day-old correct answer now loses at most
// (1 - COMPOSITE_DISCOUNT_FLOOR) of its score, never the 30-95% the
// unconditional formula could take.
//
// COMPOSITE_DISCOUNT_FLOOR (env: FLAIR_COMPOSITE_DISCOUNT_FLOOR) and
// COMPOSITE_RELEVANCE_FLOOR (env: FLAIR_COMPOSITE_RELEVANCE_FLOOR, default
// 0.5, same value as RBOOST_RELEVANCE_FLOOR): below the relevance floor the
// durability/recency multiplier is fully neutral (1.0); at/above it, the
// multiplier is dWeight×rFactor linearly remapped from its native [0,1] range
// into [COMPOSITE_DISCOUNT_FLOOR, 1.0] — so a `permanent`+fresh record still
// scores strictly higher than a `standard`+stale one among relevant
// candidates (durability/recency remains a real, monotonic signal), but
// never by more than the bounded amount.
//
// DISCOUNT_FLOOR_DEFAULT = 0.98 (max -2%) was tuned empirically against
// recall-harness's 87-record corpus (test/bench/recall-harness/run.ts,
// hybrid=true, 3 runs, deterministic/±0.000 SE on this corpus): 0.9 (max
// -10%, symmetric with RBOOST_CAP's +10%) recovered p@3 to match raw exactly
// (0.967) but MRR still trailed raw by -0.150 (0.742 vs 0.892) — the bounded
// discount was still large enough to occasionally reorder within the top-3,
// just not enough to push the right answer OUT of it. 0.95 narrowed the MRR
// gap to -0.078. 0.98 closed it to +0.000 on both metrics across all 3 runs
// — this corpus's RRF-normalized rawScore band is tight enough that even a
// 5-10% durability/recency swing is bigger than the real relevance gap
// between candidates. Re-run recall-harness (and recall-eval.mjs on the live
// corpus) before changing this default or reconsidering scoring defaults.
export const COMPOSITE_RELEVANCE_FLOOR_DEFAULT = 0.5;
export const COMPOSITE_DISCOUNT_FLOOR_DEFAULT = 0.98; // max -2% — tuned to fully close the gap to raw on recall-harness

export function getCompositeRelevanceFloor(): number {
  const v = Number(process.env.FLAIR_COMPOSITE_RELEVANCE_FLOOR);
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : COMPOSITE_RELEVANCE_FLOOR_DEFAULT;
}

export function getCompositeDiscountFloor(): number {
  const v = Number(process.env.FLAIR_COMPOSITE_DISCOUNT_FLOOR);
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : COMPOSITE_DISCOUNT_FLOOR_DEFAULT;
}

// flair#683 (2026-07-11, K&S-approved FLAIR-USAGE-FEEDBACK-SIGNAL.md): usage
// REPLACES retrieval as compositeScore's reinforcement term. Kern's Q1
// verdict: replace `retrievalBoost` OUTRIGHT rather than weight usage above
// it — retrievalCount is the CONTAMINATED signal (a search hit counted as
// "used"); keeping it in the formula at any weight keeps the contamination,
// because the problem is signal QUALITY, not magnitude. usageCount is
// strictly more informative (usage implies retrieval happened; retrieval
// never implies usage). Clean degeneration: on a record with no reported
// usage yet (the overwhelming majority of the corpus until usage accrues),
// usageCount=0 → usageBoost=1.0 → compositeScore collapses to
// semantic × durability/recency, with NO retrieval-popularity pollution at
// all — a strictly cleaner default state than the pre-#683 formula ever had.
// retrievalCount/retrievalBoost remain exported above (unused here) —
// keeping retrievalCount as a fallback "weak prior" for not-yet-used records
// is an explicitly-deferred v2 idea (FLAIR-USAGE-FEEDBACK-SIGNAL.md's K&S
// verdict), not built in this slice.
export function compositeScore(
  semanticScore: number,
  record: { durability?: string; createdAt?: string; usageCount?: number; supersedes?: string },
): number {
  const durability = record.durability ?? "standard";
  const dWeight = DURABILITY_WEIGHTS[durability] ?? 0.7;
  const rFactor = record.createdAt ? recencyFactor(record.createdAt, durability) : 1.0;
  // Only apply the usage boost when the record is genuinely relevant to this
  // query (semanticScore clears the floor) — same relevance-gate rationale
  // OPS-AYGD established for retrievalBoost: below the floor, a heavily-used
  // doc gets no lift, so a used-but-irrelevant-to-THIS-query record can't
  // magnet its way into an unrelated result set.
  const uBoost = semanticScore >= USAGE_RELEVANCE_FLOOR ? usageBoost(record.usageCount ?? 0) : 1.0;

  // Bound dWeight×rFactor into [discountFloor, 1.0] (a gentle nudge, mirroring
  // RBOOST_CAP), then relevance-gate it (mirroring RBOOST_RELEVANCE_FLOOR): no
  // adjustment at all below the floor, the bounded nudge at/above it.
  const discountFloor = getCompositeDiscountFloor();
  const dWeightRecency = dWeight * rFactor; // native range ~[0, 1]
  const boundedDWeightRecency = discountFloor + (1 - discountFloor) * dWeightRecency; // remapped to [discountFloor, 1]
  const relevanceFloor = getCompositeRelevanceFloor();
  const gatedDWeightRecency = semanticScore >= relevanceFloor ? boundedDWeightRecency : 1.0;

  return semanticScore * gatedDWeightRecency * uBoost;
}
