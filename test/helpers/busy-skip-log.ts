/**
 * busy-skip-log.ts — the complete-interval check for the flair#2441 busy-skip
 * case (test/integration/confirm-stored-row-before-write-2441.test.ts).
 *
 * Harper's captured stdout/stderr reaches the test asynchronously, so a
 * snapshot taken when the skip line first appears can predate a later line on
 * the same stream. This check waits for a request-completion boundary — a
 * marker request whose completion line Harper logs after the writer's request
 * has returned — and returns the interval from the writer request's start
 * through that boundary, so a line that arrived after the skip line is still
 * inside the interval being checked.
 */

export interface BusySkipInterval {
  /** Captured log from the request's start through the boundary line. */
  interval: string;
  skip: boolean;
  caught: boolean;
}

const POLL_MS = 25;

/**
 * The interval from `from` through the first `boundary` line, or null while
 * the capture has not reached the boundary. `from` is a length in the same
 * captured text `capture()` returns.
 */
export function busySkipInterval(
  captured: string,
  from: number,
  boundary: string,
  skipLine: string,
  catchMarker: string,
): BusySkipInterval | null {
  const appended = captured.slice(from);
  const end = appended.indexOf(boundary);
  if (end === -1) return null;
  const interval = appended.slice(0, end + boundary.length);
  return { interval, skip: interval.includes(skipLine), caught: interval.includes(catchMarker) };
}

/**
 * Poll `capture()` until it reaches `boundary`, then return the complete
 * interval. Bounded by `timeoutMs`; null when the boundary never arrives.
 */
export async function waitForBusySkipInterval(
  capture: () => string,
  from: number,
  boundary: string,
  skipLine: string,
  catchMarker: string,
  timeoutMs: number,
  pollMs: number = POLL_MS,
): Promise<BusySkipInterval | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = busySkipInterval(capture(), from, boundary, skipLine, catchMarker);
    if (found) return found;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
