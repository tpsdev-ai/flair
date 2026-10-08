/**
 * restart-wait-deadline-2357.test.ts — flair#2357.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { waitForProcessExit } from "../../src/cli.ts";
import type { PidLiveness } from "../../src/lib/daemon-liveness.ts";

describe("flair#2357 — the restart wait caps sleeps and probes once after the last wake", () => {
  test.each(Array.from({ length: 20 }, (_, run) => run))("stops when the probe consumes the remaining time (run %i)", async () => {
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

  for (const overshoot of [0, 1, 20]) {
    describe(`timer overshoot ${overshoot}ms`, () => {
      for (const exits of [false, true]) {
        test.each(Array.from({ length: 20 }, (_, run) => run))(
          `${exits ? "observes an exit before the deadline" : "times out after the final post-wake probe"} (run %i)`,
          async () => {
            let now = 1_000_000;
            const deadline = now + 750;
            const exitAt = deadline - 100;
            const starts: number[] = [];
            const sleeps: number[] = [];
            const clock = spyOn(Date, "now").mockImplementation(() => now);
            const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay: number) => {
              expect(delay).toBeLessThanOrEqual(deadline - now);
              sleeps.push(delay);
              now += delay + overshoot;
              callback();
              return 0;
            }) as typeof setTimeout);
            try {
              const waiting = waitForProcessExit(4242, 750, () => {
                starts.push(Date.now());
                return { kind: exits && now >= exitAt ? "gone" : "alive" };
              });
              if (exits) await expect(waiting).resolves.toBeUndefined();
              else await expect(waiting).rejects.toThrow("Process 4242 did not exit within 750ms");
              expect(sleeps).toEqual([500, 250 - overshoot]);
              expect(now).toBe(deadline + overshoot);
              expect(starts).toEqual([deadline - 750, deadline - 250 + overshoot, deadline + overshoot]);
              expect(starts.filter((at) => at > deadline)).toHaveLength(overshoot === 0 ? 0 : 1);
            } finally {
              timer.mockRestore();
              clock.mockRestore();
            }
          },
        );
      }
    });
  }

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
