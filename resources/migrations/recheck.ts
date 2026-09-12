/**
 * recheck.ts — follow-up migration cycles after the boot-keyed first pass
 * (flair#1073).
 *
 * The boot runner fires once via `setImmediate` after tables exist. On a
 * Fabric component deploy that is not enough: Memory.search can be a live
 * accessor before the replica's rows are visible, so embedding-stamp's
 * detect() returns false, the cycle records "nothing pending" / completed,
 * and a long-lived process never looks again. These delayed rechecks are
 * the live self-heal — the same runMigrationCycle, single-flight lock
 * included, so a no-op is cheap (alwaysDetect detect() is limit=1) and a
 * mid-flight first cycle just gets `single-flight` from the later one.
 *
 * Delays are spaced to cover the Fabric boot race (tens of seconds) and a
 * slow replica catch-up (minutes), not an infinite poll. A process that
 * is still split after the last delay will be picked up on the next
 * restart (alwaysDetect) or the next `upgrade --target` stamp-convergence
 * verify.
 */
export const DEFAULT_STAMP_RECHECK_DELAYS_MS: readonly number[] = [
  30_000,
  120_000,
  600_000,
];

export interface FollowUpScheduler {
  cancel(): void;
  /** Delays actually scheduled — exposed for tests. */
  delaysMs: readonly number[];
}

export interface ScheduleFollowUpCyclesOpts {
  run: () => Promise<void>;
  delaysMs?: readonly number[];
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export function scheduleFollowUpCycles(opts: ScheduleFollowUpCyclesOpts): FollowUpScheduler {
  const delaysMs = opts.delaysMs ?? DEFAULT_STAMP_RECHECK_DELAYS_MS;
  const setT = opts.setTimeoutFn ?? setTimeout;
  const clearT = opts.clearTimeoutFn ?? clearTimeout;
  const timers: ReturnType<typeof setTimeout>[] = [];
  for (const ms of delaysMs) {
    timers.push(
      setT(() => {
        void opts.run();
      }, ms),
    );
  }
  return {
    delaysMs,
    cancel() {
      for (const t of timers) clearT(t);
      timers.length = 0;
    },
  };
}
