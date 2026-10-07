/**
 * pid-liveness-zombie-2330.test.ts — flair#2330.
 *
 * #2313 made the probe read the process state after signal 0 and report a
 * zombie `gone`. On a loaded macOS runner the Darwin state read intermittently
 * failed (`ps` timed out or returned nothing), returned null, and the fail-safe
 * reported the zombie `alive` — the earlier fix, undone by one unreadable read.
 *
 * #2330 retries a failed or empty state read once, and `flair doctor`'s stop
 * wait re-reads the state on every poll. These tests inject a failing and a slow
 * state read and show the probe and the stop wait still reach `gone` within a
 * bounded time; a read that keeps failing stays `alive` (fail safe).
 */
import { describe, expect, test } from "bun:test";
import { probePidLiveness, waitForPidGone } from "../../src/cli.ts";

// A real, live pid, so `kill(pid, 0)` succeeds and the injected state read is
// the one that decides the verdict.
const LIVE_PID = process.pid;

/** A read that fails (`null`) `failures` times, then reports the state `then`. */
function readFailingThen(failures: number, then: string): (pid: number) => string | null {
  let calls = 0;
  return () => (calls++ < failures ? null : then);
}

describe("flair#2330 — the probe retries a failed or empty state read", () => {
  test("a read that fails once then reports Z is gone (one retry)", () => {
    expect(probePidLiveness(LIVE_PID, readFailingThen(1, "Z")).kind).toBe("gone");
  });

  test("a read that keeps failing is unreadable and stays alive (fail safe)", () => {
    expect(probePidLiveness(LIVE_PID, readFailingThen(2, "Z")).kind).toBe("alive");
    expect(probePidLiveness(LIVE_PID, readFailingThen(9, "Z")).kind).toBe("alive");
  });

  test("a read that reports a running state stays alive", () => {
    expect(probePidLiveness(LIVE_PID, readFailingThen(3, "S")).kind).toBe("alive");
  });

  test("a slow read still reports a zombie gone within a bounded time", () => {
    const slow = () => { const end = Date.now() + 25; while (Date.now() < end) { /* spin */ } return "Z"; };
    const started = Date.now();
    expect(probePidLiveness(LIVE_PID, slow).kind).toBe("gone");
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("flair#2330 — the stop wait re-reads the state on its next poll", () => {
  test("a read that fails through the first poll then reports Z reaches gone within the wait", async () => {
    // Two failures exhaust one poll's read plus its single retry; the next poll
    // reads Z. A stop wait that trusted the first (failed) read would never see
    // the zombie.
    const started = Date.now();
    const outcome = await waitForPidGone(LIVE_PID, Date.now() + 2_000, readFailingThen(2, "Z"), 10);
    expect(outcome.gone).toBe(true);
    expect(outcome.last.kind).toBe("gone");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("a slow read that reports Z on the next poll reaches gone within the wait", async () => {
    let calls = 0;
    const slow = () => { const end = Date.now() + 20; while (Date.now() < end) { /* spin */ } return calls++ < 2 ? null : "Z"; };
    const started = Date.now();
    const outcome = await waitForPidGone(LIVE_PID, Date.now() + 2_000, slow, 10);
    expect(outcome.gone).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("a read that never stops failing ends the wait alive at the deadline (fail safe)", async () => {
    const deadline = Date.now() + 250;
    const outcome = await waitForPidGone(LIVE_PID, deadline, () => null, 10);
    expect(outcome.gone).toBe(false);
    expect(outcome.last.kind).toBe("alive");
    expect(Date.now()).toBeGreaterThanOrEqual(deadline - 50);
  });
});
