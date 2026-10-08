/**
 * restart-wait-deadline-2357.test.ts — flair#2357.
 *
 * `waitForProcessExit` is the restart path's wait for the old Harper process to
 * exit before /Health is polled. It polled liveness on a loop and then started
 * one more probe after the deadline had passed, so a probe could begin at or
 * after the deadline. This test injects a slow probe and mocks the clock so each
 * probe's start time is recorded against the deadline, and asserts that no probe
 * starts at or after it.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { waitForProcessExit } from "../../src/cli.ts";
import type { PidLiveness } from "../../src/lib/daemon-liveness.ts";

describe("flair#2357 — the restart wait starts no probe at or after its deadline", () => {
  test("no probe starts at or after the deadline", async () => {
    const timeoutMs = 30;
    let now = 1_000_000;
    const deadline = now + timeoutMs;
    const starts: number[] = [];
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    // A slow probe: its first call consumes the window up to the deadline (the
    // mocked clock advances to it) and reports alive, so the wait can only stop
    // by timing out.
    const probe = (_pid: number): PidLiveness => {
      starts.push(Date.now());
      now = deadline;
      return { kind: "alive" };
    };
    try {
      await expect(waitForProcessExit(4242, timeoutMs, probe)).rejects.toThrow(
        `Process 4242 did not exit within ${timeoutMs}ms`,
      );
      expect(starts.length).toBeGreaterThan(0);
      expect(starts.every((at) => at < deadline)).toBe(true);
    } finally {
      clock.mockRestore();
    }
  });
});
