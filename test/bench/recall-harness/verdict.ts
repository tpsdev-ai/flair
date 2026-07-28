/**
 * verdict.ts — is an A/B delta a real difference, or an artefact?
 *
 * Split out of run.ts so it can be unit-tested (run.ts executes its sweep at
 * import time, so a test can't import it without spawning Harper).
 *
 * WHY THIS EXISTS (flair#888). The obvious rule — "|Δ| > standard error ⇒
 * real" — is wrong for this instrument, and wrong in the dangerous direction.
 * Every measurement this harness has ever published came back with **±0.000
 * variance across runs**: the corpus is fixed, the HNSW build is
 * deterministic, and the same queries run against the same records. When SE
 * is exactly zero, *any* nonzero delta "exceeds" it, so that rule promotes a
 * two-query reshuffle to a significant finding.
 *
 * That is not hypothetical. The A/B this rule was written during measured
 * +0.003 MRR at Δp@3 exactly 0.000 and four times the query latency; under
 * "|Δ| > SE" it would have been reported as clearing the error bars, and
 * "+0.003 MRR, statistically significant" is precisely the sentence that gets
 * quoted as justification a year later. Under the rule below it comes back
 * `below-resolution`, which is what it was. (The feature that produced it was
 * removed on that evidence — flair#891, flair#893 — but the rule is the part
 * worth keeping: it applies to every retrieval change measured here.)
 *
 * So the delta is checked against TWO floors:
 *
 *  1. **Run-to-run noise** — the combined standard error of the two arms'
 *     means, √(SE_a² + SE_b²). Real when the instrument is noisy.
 *  2. **The instrument's resolution** — how much of a delta a single query
 *     can even produce. p@3 over N queries moves in steps of 1/N, so a delta
 *     worth less than one whole query is not a query changing its top-3
 *     membership; it is rounding. For MRR the natural unit is one query
 *     moving one rank at the top of the list (rank 2 → rank 1 = 0.5
 *     reciprocal-rank points, the largest single-rank move available), so a
 *     total movement below that is smaller than the smallest change a single
 *     query could meaningfully make.
 *
 * A delta under EITHER floor is not a difference this instrument can see.
 * Reporting it in query units rather than in three decimal places is the
 * point: "+0.4 reciprocal-rank points across 126 queries" cannot be mistaken
 * for a result the way "+0.003" can.
 */

/** One query moving from rank 2 to rank 1 — the largest reciprocal-rank gain
 * a single query can contribute from a single-position move, and therefore
 * the floor below which a TOTAL movement is smaller than any one query's
 * meaningful step. */
export const MRR_RESOLUTION_RR_POINTS = 0.5;

export type DeltaVerdict =
  /** Fewer than 2 runs — there is no variance estimate at all. */
  | "no-variance-estimate"
  /** Smaller than what a single query can produce. Not a difference. */
  | "below-resolution"
  /** Within run-to-run noise. Not a difference. */
  | "inside-error-bars"
  /** Bigger than both floors — a real movement, to be weighed against cost. */
  | "resolved";

export interface DeltaInput {
  /** Mean p@3 difference (b − a). */
  dP3: number;
  /** Mean MRR difference (b − a). */
  dMrr: number;
  /** Combined SE of the p@3 difference, or null with <2 runs. */
  seP3: number | null;
  /** Combined SE of the MRR difference, or null with <2 runs. */
  seMrr: number | null;
  /** Number of ground-truth queries per run — the unit conversion. */
  nQueries: number;
}

export interface DeltaClassification {
  verdict: DeltaVerdict;
  /** Δp@3 expressed as whole queries entering/leaving the top 3. */
  p3Queries: number;
  /** ΔMRR expressed as total reciprocal-rank points across the query set. */
  mrrPoints: number;
  /** One line, quotable, saying what the verdict means. */
  explanation: string;
}

export function classifyDelta(i: DeltaInput): DeltaClassification {
  const p3Queries = i.dP3 * i.nQueries;
  const mrrPoints = i.dMrr * i.nQueries;
  const base = { p3Queries, mrrPoints };

  if (i.seP3 == null || i.seMrr == null) {
    return {
      ...base,
      verdict: "no-variance-estimate",
      explanation: "SINGLE RUN: no variance estimate exists. Re-run with --runs 3 or more before treating this delta as real in either direction.",
    };
  }

  // Resolution first: "the instrument cannot see a delta this small" is a
  // stronger and more useful statement than "it's within noise", and on a
  // deterministic corpus (SE=0) it is the only one of the two that bites.
  if (Math.abs(p3Queries) < 1 && Math.abs(mrrPoints) < MRR_RESOLUTION_RR_POINTS) {
    return {
      ...base,
      verdict: "below-resolution",
      explanation:
        `BELOW THIS INSTRUMENT'S RESOLUTION: p@3 moved ${p3Queries.toFixed(1)} queries (not one query entered or left the top 3 across all ${i.nQueries}), ` +
        `and total MRR movement is ${mrrPoints.toFixed(2)} reciprocal-rank points — less than the ${MRR_RESOLUTION_RR_POINTS} a SINGLE query gains moving from rank 2 to rank 1. ` +
        `Not a difference.`,
    };
  }

  if (Math.abs(i.dP3) <= i.seP3 && Math.abs(i.dMrr) <= i.seMrr) {
    return {
      ...base,
      verdict: "inside-error-bars",
      explanation: "INSIDE THE ERROR BARS on both metrics: run-to-run noise is as large as the effect. Not a difference.",
    };
  }

  return {
    ...base,
    verdict: "resolved",
    explanation:
      `RESOLVED: ${p3Queries.toFixed(1)} queries of p@3 movement and ${mrrPoints.toFixed(2)} reciprocal-rank points of MRR movement, ` +
      `above both run-to-run noise and single-query resolution. Weigh it against the measured cost before changing any default.`,
  };
}
