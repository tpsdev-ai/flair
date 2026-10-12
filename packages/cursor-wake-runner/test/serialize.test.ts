import { describe, expect, test } from "bun:test";
import { startSerialTicks } from "../src/cli.ts";

/**
 * flair#1944 round 2 — `--interval` must serialize its own cycles.
 *
 * `startSerialTicks` is the exact scheduler `main()` runs under `--interval`:
 * the next tick is scheduled only from the previous tick's completion, so one
 * runner can never overlap its own cycles. A fixed `setInterval` would start a
 * new tick on a wall-clock schedule regardless of an in-flight cycle.
 *
 */
describe("startSerialTicks — a delayed cycle is never overlapped (flair#1944 round 2)", () => {
  test("a cycle slower than the interval never runs concurrently with the next", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let starts = 0;
    const CYCLE_MS = 30;

    // The tick stays pending longer than the configured interval.
    const serial = startSerialTicks(async () => {
      starts += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, CYCLE_MS));
      inFlight -= 1;
    }, 0.005);

    // Long enough for several 30 ms cycles to have run.
    await new Promise((resolve) => setTimeout(resolve, 200));
    serial.stop();
    // Let any final in-flight cycle settle before asserting.
    await new Promise((resolve) => setTimeout(resolve, CYCLE_MS + 10));

    expect(maxInFlight, "one runner must never overlap its own cycles").toBe(1);
    expect(starts, "the interval loop must keep ticking").toBeGreaterThanOrEqual(3);
  });

  test("the first tick runs without waiting for the interval, and stop() ends the loop", async () => {
    let starts = 0;
    const serial = startSerialTicks(async () => {
      starts += 1;
    }, 0.005);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(starts).toBe(1);
    serial.stop();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(starts).toBe(1);
  });
});
