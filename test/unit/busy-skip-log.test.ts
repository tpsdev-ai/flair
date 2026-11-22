/**
 * busy-skip-log.test.ts — the captured-log interval check used by the
 * flair#2441 busy-skip case, with no Harper.
 *
 * The regression this pins down: the skip line and the caught-exception line
 * arrive in separate capture chunks, the catch after the skip. The check must
 * wait for its boundary and report the catch; returning at the first skip line
 * misses it.
 */
import { describe, expect, it } from "bun:test";
import { waitForBusySkipInterval } from "../helpers/busy-skip-log";

const SKIP = "[usage-recording] contribution skipped: busy for memory m-1\n";
const CAUGHT = "RecordUsage.post: failed to record usage\n";
const BOUNDARY = "GET /csr-log-boundary-1 HTTP/1.1 404\n";

describe("flair#2441 busy-skip captured-log interval", () => {
  it("reports a catch line that arrives in a chunk after the skip line", async () => {
    let polls = 0;
    const capture = () => {
      polls += 1;
      return polls < 3 ? SKIP : SKIP + CAUGHT + BOUNDARY;
    };
    const found = await waitForBusySkipInterval(capture, 0, BOUNDARY, SKIP, "RecordUsage.post:", 2_000, 1);
    expect(found).not.toBeNull();
    expect(found?.skip).toBe(true);
    expect(found?.caught, "the catch line after the skip line was outside the interval").toBe(true);
  }, 10_000);

  it("returns the interval through the boundary when the catch line is absent", async () => {
    const capture = () => SKIP + BOUNDARY + CAUGHT;
    const found = await waitForBusySkipInterval(capture, 0, BOUNDARY, SKIP, "RecordUsage.post:", 1_000, 1);
    expect(found).not.toBeNull();
    expect(found?.skip).toBe(true);
    expect(found?.caught, "a line after the boundary was included in the interval").toBe(false);
  }, 10_000);

  it("returns null when the boundary never reaches the capture", async () => {
    const found = await waitForBusySkipInterval(() => SKIP, 0, BOUNDARY, SKIP, "RecordUsage.post:", 100, 1);
    expect(found).toBeNull();
  }, 10_000);
});
