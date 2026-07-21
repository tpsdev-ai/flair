/**
 * abstention.ts — first-class recall abstention ("no memory covers this")
 * (flair#744 slice 2).
 *
 * ─── What this is ────────────────────────────────────────────────────────────
 * Weak matches presented as answers are how a memory system *causes*
 * confabulation instead of preventing it. When the best retrieval match is
 * below a confidence floor, the honest response is a first-class "no memory
 * covers this" verdict — NOT the N weakest matches dressed up as an answer.
 * This module is the PURE, Harper-free decision core the recall wrappers
 * (SemanticSearch.post, BootstrapMemories.post) consult in their response tail,
 * strictly downstream of retrieval + read-scope resolution.
 *
 * ─── Opt-in, conservative, calibration is a SEPARATE follow-up ──────────────
 * Slice 2 ships the abstention *response shape*, decoupled from threshold
 * *calibration* (the design round's explicit sharpening). Consumers build
 * against the API shape now; the promote-to-default calibration on the
 * recall-bench corpus proceeds independently (NOT this slice). Until then the
 * mode is opt-in (`abstain` request flag, default OFF ⇒ recall is byte-identical
 * to today) and the threshold is a deliberately CONSERVATIVE hand-set constant
 * that errs toward returning results rather than over-abstaining.
 *
 * ─── The GLOBAL-threshold invariant (flair#744 Sherlock BINDING condition 2) ─
 * The abstention threshold MUST be GLOBAL (or scope-wide) and NEVER
 * per-principal. A per-principal threshold ("this principal's memories need
 * higher confidence to surface") would be an authority lever and would violate
 * the zero-authority trust spine — the same discipline as the `claimed.*`
 * guard (flair#735). This module makes that STRUCTURAL, not just documented:
 *   1. ABSTENTION_THRESHOLD is a single module-level constant. There is no
 *      per-principal (or any) threshold parameter — `evaluateAbstention` reads
 *      the constant directly, so there is no lever to vary it per principal.
 *   2. The decision consults ONLY a retrieval-confidence number. Neither
 *      function below takes — or this module anywhere imports — an agentId,
 *      principal, trust tier, or any authority signal. Enforced structurally by
 *      test/unit/abstention-no-per-principal-tripwire.test.ts (the module is
 *      scanned for authority tokens, and the decision function's arity is
 *      pinned to its single numeric input).
 */

/**
 * ABSTENTION_THRESHOLD — the single GLOBAL retrieval-confidence floor.
 *
 * When the best-match absolute semantic similarity (cosine, [0,1] — see
 * `bestSemanticSimilarity`) is below this value, opt-in recall abstains
 * ("no memory covers this") instead of returning the N weak matches.
 *
 * GLOBAL / data-driven, NEVER per-principal (Sherlock binding condition 2).
 *
 * CONSERVATIVE hand-set value (0.15): well below the strong-match band real
 * embeddings produce for genuinely relevant memories, and below bootstrap's
 * own long-standing task-relevance floor (0.3, resources/MemoryBootstrap.ts's
 * TASK_RELEVANCE_FLOOR) — so abstention fires only when there is essentially
 * nothing semantically near the query, erring toward returning results rather
 * than over-abstaining. Promoting abstention to the DEFAULT recall mode, and
 * tuning this value on the recall-bench corpus, is a SEPARATE follow-up (see
 * flair#744) — this slice ships the response shape at a safe opt-in floor, not
 * the calibrated default.
 */
export const ABSTENTION_THRESHOLD = 0.15;

/**
 * The abstention verdict returned to the reader. Stable shape a consumer builds
 * against in opt-in mode: `abstained` is always present; `reason` only when it
 * abstained; `bestScore` is the best-match confidence the decision saw (null
 * when there was no embedding-based match to judge); `threshold` is the global
 * floor for transparency.
 */
export interface AbstentionResult {
  abstained: boolean;
  bestScore: number | null;
  threshold: number;
  reason?: string;
}

/**
 * Pick the best absolute semantic similarity across a retrieval candidate pool.
 *
 * Reads ONLY the `_semSimilarity` number the retrieval core
 * (resources/semantic-retrieval-core.ts) attaches to each semantic-leg result
 * WHEN abstention is requested — an absolute cosine similarity in [0,1],
 * independent of the RRF normalization / rerank that make the ranking `_score`
 * a *relative* signal (the top RRF-fused result is normalized to 1.0 regardless
 * of how weak the actual match is, so `_score` is unusable as a confidence
 * floor — this is why abstention reads the absolute similarity instead).
 *
 * Returns null when NO candidate carries a `_semSimilarity` (no embedding-based
 * match at all — e.g. a keyword-only degraded search, or an empty pool). Per
 * `evaluateAbstention`, null ⇒ never abstain (conservative: a degraded recall
 * that couldn't even judge confidence should return what it found, not a
 * confident "nothing covers this").
 *
 * PURE and authority-free: reads a single numeric field off each candidate,
 * never any principal / agentId / tier / scope. It cannot make the decision
 * per-principal because it never sees a principal.
 */
export function bestSemanticSimilarity(
  candidates: ReadonlyArray<{ _semSimilarity?: number | null }>,
): number | null {
  let best: number | null = null;
  for (const c of candidates) {
    const s = c?._semSimilarity;
    if (typeof s === "number" && Number.isFinite(s) && (best === null || s > best)) {
      best = s;
    }
  }
  return best;
}

/**
 * The abstention decision. PURE, and its ONLY input is a single confidence
 * number (or null) — there is deliberately no threshold parameter and no
 * principal parameter, so the outcome cannot be varied per principal (Sherlock
 * binding condition 2): the threshold is always the module-global
 * ABSTENTION_THRESHOLD.
 *
 *   - bestScore === null  ⇒ never abstain (no embedding-based match to judge;
 *                            conservative — return what was found).
 *   - bestScore < floor   ⇒ abstain ("no memory covers this").
 *   - bestScore >= floor  ⇒ do not abstain (return normal results).
 */
export function evaluateAbstention(bestScore: number | null): AbstentionResult {
  const threshold = ABSTENTION_THRESHOLD;
  const abstained = bestScore !== null && bestScore < threshold;
  return abstained
    ? { abstained: true, bestScore, threshold, reason: "no memory above confidence threshold" }
    : { abstained: false, bestScore, threshold };
}
