/**
 * ingest-throughput-control.ts — the negative-control decision as a pure
 * function (flair#1436).
 *
 * Extracted from test/bench/ingest-throughput/run.ts so the gate's pass/fail
 * logic is unit-testable with pure inputs — no Harper, no model, no CI lane.
 * Lives in test/unit/ (not test/bench/) so the test that proves the control
 * can fire is itself reachable from a CI command. The whole point of the
 * negative control is that its PASS must carry information: it must be able to
 * FAIL. A control that can only pass (e.g. one that proceeds on missing data)
 * is the same defect this harness exists to prevent, one layer up.
 */

export interface NegativeControlDecision {
  /** low.tokPerSec / high.tokPerSec. < 1 means low is slower. */
  ratio: number;
  /** True when low is materially slower than high (ratio below threshold). */
  passed: boolean;
  /** True when the run must abort (BLOCKED): low is not materially slower, or
   *  the measurement is missing/invalid (non-finite ratio). */
  blocked: boolean;
}

export function decideNegativeControl(
  lowTokPerSec: number,
  highTokPerSec: number,
  threshold: number,
): NegativeControlDecision {
  const ratio = lowTokPerSec / highTokPerSec;
  // A non-finite ratio means the measurement is missing or invalid — e.g. a
  // failed warm-up yields 0 tokens over 0 ms → 0/0 = NaN. `NaN < threshold` is
  // false in JS, which would (accidentally) block, but we make it EXPLICIT:
  // never proceed on bad data. The gate must fail toward BLOCKED, not proceed.
  const passed = Number.isFinite(ratio) && ratio < threshold;
  return { ratio, passed, blocked: !passed };
}
