/**
 * migrations-recheck.test.ts — delayed follow-up cycles (flair#1073).
 */
import { describe, it, expect } from "bun:test";
import { scheduleFollowUpCycles, DEFAULT_STAMP_RECHECK_DELAYS_MS } from "../../resources/migrations/recheck.ts";

describe("scheduleFollowUpCycles", () => {
  it("schedules one timer per delay and cancel() clears them", () => {
    const scheduled: number[] = [];
    const cleared: unknown[] = [];
    const handles: number[] = [];
    let next = 1;
    const setTimeoutFn = ((cb: () => void, ms: number) => {
      scheduled.push(ms);
      const id = next++;
      handles.push(id);
      void cb;
      return id as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    const clearTimeoutFn = ((id: ReturnType<typeof setTimeout>) => {
      cleared.push(id);
    }) as typeof clearTimeout;

    const sched = scheduleFollowUpCycles({
      run: async () => undefined,
      setTimeoutFn,
      clearTimeoutFn,
    });
    expect(sched.delaysMs).toEqual(DEFAULT_STAMP_RECHECK_DELAYS_MS);
    expect(scheduled).toEqual([...DEFAULT_STAMP_RECHECK_DELAYS_MS]);
    sched.cancel();
    expect(cleared).toHaveLength(DEFAULT_STAMP_RECHECK_DELAYS_MS.length);
  });

  it("fires run() once per delay when timers elapse", async () => {
    const callbacks: Array<() => void> = [];
    const setTimeoutFn = ((cb: () => void) => {
      callbacks.push(cb);
      return callbacks.length as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    let runs = 0;
    scheduleFollowUpCycles({
      run: async () => {
        runs++;
      },
      delaysMs: [1, 2, 3],
      setTimeoutFn,
    });
    expect(callbacks).toHaveLength(3);
    for (const cb of callbacks) cb();
    await Promise.resolve();
    expect(runs).toBe(3);
  });
});
