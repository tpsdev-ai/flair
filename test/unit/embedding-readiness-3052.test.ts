import { describe, expect, test } from "bun:test";
import {
  awaitEmbeddingReady,
  isProviderTimeout,
  MAX_READINESS_ATTEMPTS,
} from "../../scripts/ci/embedding-readiness.mjs";

/**
 * flair#3052 — the readiness wait is bounded by TOTAL ELAPSED TIME.
 *
 * Each provider call ends at the server's own ~20 s bound, so a fixed attempt
 * count gives up at ~62 s however generous the per-attempt budget is. These
 * cases use a virtual clock: an attempt costs PROVIDER_BOUND_MS, and a retry
 * backoff costs EMBEDDING_RETRY_BACKOFF_MS, so the deadline arithmetic is
 * exercised exactly without waiting in real time.
 */

const PROVIDER_BOUND_MS = 20_000;
const BACKOFF_MS = 1_000;

function virtualClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms: number) => { t += ms; },
    advance: (ms: number) => { t += ms; },
    elapsed: () => t - start,
  };
}

const providerTimeout = () => new Response('{"error":"memory_provider_timeout"}', { status: 503 });
const accepted = () => new Response("{}", { status: 200 });

describe("embedding readiness waits on total elapsed time (flair#3052)", () => {
  test("more slow 503s than the old three-attempt cap still reaches success within the deadline", async () => {
    const clock = virtualClock();
    let attempts = 0;
    const result = await awaitEmbeddingReady({
      label: "unit",
      deadlineMs: 180_000,
      now: clock.now,
      sleep: clock.sleep,
      log: () => {},
      attempt: async () => {
        attempts += 1;
        clock.advance(PROVIDER_BOUND_MS);
        return attempts <= 5 ? providerTimeout() : accepted();
      },
    });

    // 5 timeouts + 1 success, each 20 s plus 5 s of backoff.
    expect(result.attempts).toBe(6);
    expect(result.elapsedMs).toBe(6 * PROVIDER_BOUND_MS + 5 * BACKOFF_MS);
    expect(result.elapsedMs).toBe(clock.elapsed());
  }, 5_000);

  test("never ready fails at the deadline, naming the elapsed time", async () => {
    const clock = virtualClock();
    let attempts = 0;
    const call = awaitEmbeddingReady({
      label: "unit",
      deadlineMs: 60_000,
      now: clock.now,
      sleep: clock.sleep,
      log: () => {},
      attempt: async () => {
        attempts += 1;
        clock.advance(PROVIDER_BOUND_MS);
        return providerTimeout();
      },
    });

    const error = await call.then(() => null, (err: Error) => err);
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain("never became ready");
    // Three attempts reach 62 s and the 60 s deadline then stops the wait.
    expect(attempts).toBe(3);
    expect(error?.message).toContain("62000ms");
    expect(error?.message).toContain("3 attempt(s)");
  }, 5_000);

  test("a non-timeout answer fails at once, without retrying", async () => {
    const clock = virtualClock();
    let attempts = 0;
    const call = awaitEmbeddingReady({
      label: "unit",
      deadlineMs: 180_000,
      now: clock.now,
      sleep: clock.sleep,
      log: () => {},
      attempt: async () => {
        attempts += 1;
        clock.advance(PROVIDER_BOUND_MS);
        return new Response("boom", { status: 500 });
      },
    });

    await expect(call).rejects.toThrow("HTTP 500");
    expect(attempts).toBe(1);
  }, 5_000);

  test("503 without memory_provider_timeout is not a cold model and fails at once", async () => {
    const clock = virtualClock();
    let attempts = 0;
    const call = awaitEmbeddingReady({
      label: "unit",
      deadlineMs: 180_000,
      now: clock.now,
      sleep: clock.sleep,
      log: () => {},
      attempt: async () => {
        attempts += 1;
        clock.advance(PROVIDER_BOUND_MS);
        return new Response("upstream unavailable", { status: 503 });
      },
    });

    await expect(call).rejects.toThrow("not memory_provider_timeout");
    expect(attempts).toBe(1);
    expect(isProviderTimeout(503, "upstream unavailable")).toBe(false);
    expect(isProviderTimeout(503, '{"error":"memory_provider_timeout"}')).toBe(true);
  }, 5_000);

  test("the attempt loop keeps a hard bound even when the clock never advances", async () => {
    let attempts = 0;
    const call = awaitEmbeddingReady({
      label: "unit",
      deadlineMs: 180_000,
      now: () => 1_000_000,
      sleep: async () => {},
      log: () => {},
      attempt: async () => {
        attempts += 1;
        return providerTimeout();
      },
    });

    await expect(call).rejects.toThrow("never became ready");
    expect(attempts).toBe(MAX_READINESS_ATTEMPTS);
  }, 5_000);
});
