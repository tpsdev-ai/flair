// Adapter test for the Darwin start-time reader's `ps` child timeout (flair#2285).
//
// The doctor stop-deadline test (launchd-adopt-stop-deadline-2205) replaces the
// whole reader with a fake that enforces the deadline itself, so nothing checks
// that the REAL reader bounds the timeout it hands to each `ps` invocation by
// the caller's remaining deadline. This file calls the real reader with only
// the `ps` spawn seam stubbed, so the timeout it sees at the process boundary is
// the one the reader computed.
//
// Module mocks are process-global (as in process-start-time-clock-rate), so this
// file runs in the isolated lane.
import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";

const T0 = 1_700_000_000_000; // fake clock origin
const LSTART = "Wed Oct 10 05:37:16 2026"; // a parsable `ps -o lstart=` line

let clock = T0;
let psDurationMs = 0;
let psCalls: { timeout: number; at: number }[] = [];

mock.module("node:child_process", () => ({
  ...childProcess,
  execFileSync: (command: string, args: string[], options: { timeout: number }) => {
    expect(command).toBe("ps");
    expect(args[1]).toBe("lstart=");
    psCalls.push({ timeout: options.timeout, at: clock });
    clock += psDurationMs; // let the stubbed child consume time
    return LSTART;
  },
}));

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
let now: ReturnType<typeof spyOn>;
beforeEach(() => {
  clock = T0;
  psDurationMs = 0;
  psCalls = [];
  now = spyOn(Date, "now").mockImplementation(() => clock);
});
afterEach(() => now.mockRestore());
afterAll(() => Object.defineProperty(process, "platform", originalPlatform));

const { readProcessStartTimeMs } = await import("../../src/lib/process-start-time.js");

// A pid other than our own, so the reader makes the target read AND the
// self-calibration read: two separate `ps` invocations.
function targetPid(): number {
  return process.pid + 1000;
}

test("every ps timeout is bounded by the caller's remaining deadline, including after time has passed", () => {
  const deadline = T0 + 60_000;
  psDurationMs = 59_000; // the first read consumes most of the shared deadline
  const value = readProcessStartTimeMs(targetPid(), deadline);
  expect(value).not.toBeNull();
  expect(psCalls).toHaveLength(2);
  for (const call of psCalls) {
    const remaining = deadline - call.at;
    expect(call.timeout).toBeGreaterThan(0);
    expect(call.timeout).toBeLessThanOrEqual(remaining);
  }
  // First read: the 2 s per-call cap. Second read, after 59 s elapsed: the 1 s left.
  expect(psCalls.map((call) => call.timeout)).toEqual([2_000, 1_000]);
});

test("the first ps timeout honours a deadline shorter than the per-call cap", () => {
  const deadline = T0 + 1_500;
  psDurationMs = 200;
  const value = readProcessStartTimeMs(targetPid(), deadline);
  expect(value).not.toBeNull();
  expect(psCalls.map((call) => call.timeout)).toEqual([1_500, 1_300]);
  for (const call of psCalls) {
    expect(call.timeout).toBeLessThanOrEqual(deadline - call.at);
  }
});
