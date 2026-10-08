/**
 * restart-wait-deadline-2357.test.ts — flair#2357.
 *
 * No probe starts after the deadline; a probe at the deadline is allowed.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { waitForProcessExit } from "../../src/cli.ts";
import type { PidLiveness } from "../../src/lib/daemon-liveness.ts";

describe("flair#2357 — the restart wait starts no probe after its deadline", () => {
  test.each(Array.from({ length: 20 }, (_, run) => run))("no probe starts after the deadline (run %i)", async () => {
    const timeoutMs = 30;
    let now = 1_000_000;
    const deadline = now + timeoutMs;
    const starts: number[] = [];
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const probe = (_pid: number): PidLiveness => {
      starts.push(Date.now());
      now = deadline + 1;
      return { kind: "alive" };
    };
    try {
      await expect(waitForProcessExit(4242, timeoutMs, probe)).rejects.toThrow(
        `Process 4242 did not exit within ${timeoutMs}ms`,
      );
      expect(starts.length).toBeGreaterThan(0);
      expect(starts.every((at) => at <= deadline)).toBe(true);
    } finally {
      clock.mockRestore();
    }
  });

  test("caps the final sleep before timing out", async () => {
    let now = 1_000_000;
    const deadline = now + 750;
    const starts: number[] = [];
    const sleeps: number[] = [];
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay: number) => {
      sleeps.push(delay);
      now += delay;
      callback();
      return 0;
    }) as typeof setTimeout);
    try {
      await expect(waitForProcessExit(4242, 750, () => {
        starts.push(Date.now());
        return { kind: "alive" };
      })).rejects.toThrow("Process 4242 did not exit within 750ms");
      expect(sleeps).toEqual([500, 250]);
      expect(now).toBe(deadline);
      expect(starts).toEqual([deadline - 750, deadline - 250, deadline]);
    } finally {
      timer.mockRestore();
      clock.mockRestore();
    }
  });

  test("observes an exit during the final sleep at the deadline", async () => {
    let now = 1_000_000;
    const deadline = now + 750;
    const exitAt = deadline - 100;
    const starts: number[] = [];
    const sleeps: number[] = [];
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay: number) => {
      sleeps.push(delay);
      now += delay;
      callback();
      return 0;
    }) as typeof setTimeout);
    try {
      await expect(waitForProcessExit(4242, 750, () => {
        starts.push(Date.now());
        return { kind: now >= exitAt ? "gone" : "alive" };
      })).resolves.toBeUndefined();
      expect(sleeps).toEqual([500, 250]);
      expect(starts).toEqual([deadline - 750, deadline - 250, deadline]);
    } finally {
      timer.mockRestore();
      clock.mockRestore();
    }
  });

  test("starts no probe after an overshooting sleep", async () => {
    let now = 1_000_000;
    const deadline = now + 30;
    const starts: number[] = [];
    const sleeps: number[] = [];
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay: number) => {
      sleeps.push(delay);
      now += delay + 1;
      callback();
      return 0;
    }) as typeof setTimeout);
    try {
      await expect(waitForProcessExit(4242, 30, () => {
        starts.push(Date.now());
        return { kind: "alive" };
      })).rejects.toThrow("Process 4242 did not exit within 30ms");
      expect(sleeps).toEqual([30]);
      expect(now).toBeGreaterThan(deadline);
      expect(starts).toEqual([deadline - 30]);
    } finally {
      timer.mockRestore();
      clock.mockRestore();
    }
  });

  test("waits for a real child process to exit", async () => {
    const child = Bun.spawn([process.execPath, "-e", "setTimeout(() => process.exit(0), 10)"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      await expect(waitForProcessExit(child.pid, 2000)).resolves.toBeUndefined();
      expect(await child.exited).toBe(0);
    } finally {
      child.kill();
      await child.exited;
    }
  }, 5000);
});
