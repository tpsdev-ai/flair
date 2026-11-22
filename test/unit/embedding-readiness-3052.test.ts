import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  awaitEmbeddingReady,
  isProviderTimeout,
  MAX_READINESS_ATTEMPTS,
  PROVIDER_TIMEOUT_ERROR,
  recordStepSummary,
  warmInstanceEmbeddings,
} from "../../scripts/ci/embedding-readiness.mjs";
import {
  MEMORY_PROVIDER_TIMEOUT_ERROR,
  memoryProviderTimeoutResponse,
} from "../../resources/memory-write-lock.ts";

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

/** The response the real Memory write refusal produces, not a hand-built lookalike. */
const providerTimeout = () => memoryProviderTimeoutResponse();
const accepted = () => new Response("{}", { status: 200 });

describe("the 503 matcher reads the JSON error field (flair#3052)", () => {
  test("the helper's code matches the resource's provider-timeout code", () => {
    expect(PROVIDER_TIMEOUT_ERROR).toBe(MEMORY_PROVIDER_TIMEOUT_ERROR);
    expect(providerTimeout().status).toBe(503);
  });

  test("a 503 whose message text names the code but whose error field does not is not retryable", async () => {
    const clock = virtualClock();
    const body = '{"error":"memory_busy","message":"memory_provider_timeout would be retried"}';
    expect(isProviderTimeout(503, body)).toBe(false);

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
        return new Response(body, { status: 503 });
      },
    });

    await expect(call).rejects.toThrow("not memory_provider_timeout");
    expect(attempts).toBe(1);
  }, 5_000);

  test("an unparseable 503 body is not retryable", async () => {
    const clock = virtualClock();
    expect(isProviderTimeout(503, "memory_provider_timeout")).toBe(false);
    expect(isProviderTimeout(503, "")).toBe(false);

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
        return new Response("memory_provider_timeout", { status: 503 });
      },
    });

    await expect(call).rejects.toThrow("not memory_provider_timeout");
    expect(attempts).toBe(1);
  }, 5_000);

  test("the real refusal body is retryable", async () => {
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
});

describe("embedding readiness waits on total elapsed time (flair#3052)", () => {
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

  test("a success after the deadline is not accepted", async () => {
    const clock = virtualClock();
    let attempts = 0;
    const call = awaitEmbeddingReady({
      label: "unit",
      deadlineMs: 100,
      now: clock.now,
      sleep: clock.sleep,
      log: () => {},
      attempt: async () => {
        attempts += 1;
        clock.advance(101);
        return accepted();
      },
    });

    const error = await call.then(() => null, (err: Error) => err);
    expect(error?.message).toContain("never became ready");
    expect(error?.message).toContain("answered after the 100ms client-side wait bound");
    expect(attempts).toBe(1);
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

describe("the client bound cannot outlive the deadline (flair#3052)", () => {
  test("attempt receives decreasing remaining values as the deadline approaches", async () => {
    const clock = virtualClock();
    const remaining: number[] = [];
    let attempts = 0;
    const result = await awaitEmbeddingReady({
      label: "unit",
      deadlineMs: 2_000,
      backoffMs: 0,
      now: clock.now,
      sleep: clock.sleep,
      log: () => {},
      attempt: async (ms) => {
        remaining.push(ms);
        attempts += 1;
        clock.advance(300);
        return attempts <= 2 ? providerTimeout() : accepted();
      },
    });

    expect(result.attempts).toBe(3);
    expect(remaining).toEqual([2_000, 1_700, 1_400]);
    expect(remaining[0]).toBeGreaterThan(remaining[1]);
    expect(remaining[1]).toBeGreaterThan(remaining[2]);
  }, 5_000);

  test("every warm-up Memory fetch carries an AbortSignal", async () => {
    const calls: Array<{ url: string; hasSignal: boolean }> = [];
    const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (body?.operation === "insert" && body?.table === "Agent") {
        return new Response("inserted", { status: 200 });
      }
      if (body?.operation === "delete") return new Response("{}", { status: 200 });
      calls.push({
        url: String(url),
        hasSignal: init?.signal instanceof AbortSignal,
      });
      return new Response("{}", { status: 200 });
    };

    await warmInstanceEmbeddings({
      baseUrl: "http://127.0.0.1:1",
      opsUrl: "http://127.0.0.1:2",
      label: "unit",
      deadlineMs: 1_000,
      backoffMs: 0,
      now: () => 0,
      sleep: async () => {},
      fetchImpl: fakeFetch as typeof fetch,
    });

    expect(calls.length).toBe(1);
    expect(calls[0].url).toContain("/Memory/");
    expect(calls[0].hasSignal).toBe(true);
  }, 5_000);

  test("a TimeoutError with time left on the clock rejects as never ready", async () => {
    const clock = virtualClock();
    let attempts = 0;
    const call = awaitEmbeddingReady({
      label: "unit",
      deadlineMs: 100,
      now: clock.now,
      sleep: clock.sleep,
      log: () => {},
      attempt: async () => {
        attempts += 1;
        clock.advance(99); // now() === deadline - 1
        const err = new Error("The operation timed out");
        err.name = "TimeoutError";
        throw err;
      },
    });

    const error = await call.then(() => null, (err: Error) => err);
    expect(error?.message).toContain("never became ready");
    expect(error?.message).toContain("1 attempt(s)");
    expect(attempts).toBe(1);
  }, 5_000);

  test("a thrown non-timeout error fails at once", async () => {
    const clock = virtualClock();
    let attempts = 0;
    const call = awaitEmbeddingReady({
      label: "unit",
      deadlineMs: 100,
      now: clock.now,
      sleep: clock.sleep,
      log: () => {},
      attempt: async () => {
        attempts += 1;
        clock.advance(1);
        throw new Error("connection refused");
      },
    });

    await expect(call).rejects.toThrow("embedding provider call failed: connection refused");
    expect(attempts).toBe(1);
  }, 5_000);
});

describe("warm-up cleanup is visible and bounded (flair#3052)", () => {
  test("failed deletes fail the wait and name the memory ids and the agent", async () => {
    const calls: any[] = [];
    const fakeFetch = async (_url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      calls.push(body);
      if (body?.operation === "insert" && body?.table === "Agent") {
        return new Response("inserted", { status: 200 });
      }
      if (body?.operation === "delete") return new Response("cleanup down", { status: 500 });
      return new Response("{}", { status: 200 });
    };

    const error = await warmInstanceEmbeddings({
      baseUrl: "http://127.0.0.1:1",
      opsUrl: "http://127.0.0.1:2",
      label: "unit warm-up",
      deadlineMs: 1_000,
      backoffMs: 0,
      now: () => 0,
      sleep: async () => {},
      fetchImpl: fakeFetch as typeof fetch,
    }).then(() => null, (err: Error) => err);

    const agentId = calls.find(c => c.operation === "insert")?.records?.[0]?.id;
    const memoryDelete = calls.find(c => c.operation === "delete" && c.table === "Memory");
    const agentDelete = calls.find(c => c.operation === "delete" && c.table === "Agent");
    expect(memoryDelete, "a failed memory delete skipped the agent delete").toBeTruthy();
    expect(agentDelete).toBeTruthy();
    expect(error?.message).toContain("cleanup failed");
    expect(error?.message).toContain(memoryDelete.ids[0]);
    expect(error?.message).toContain(agentId);
  }, 5_000);

  test("a readiness failure near the deadline reports its named error and still cleans up", async () => {
    const clock = virtualClock();
    const deletes: any[] = [];
    const fakeFetch = async (_url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (body?.operation === "insert" && body?.table === "Agent") {
        return new Response("inserted", { status: 200 });
      }
      if (body?.operation === "delete") {
        deletes.push(body);
        return new Response("{}", { status: 200 });
      }
      clock.advance(60);
      return providerTimeout();
    };

    const error = await warmInstanceEmbeddings({
      baseUrl: "http://127.0.0.1:1",
      opsUrl: "http://127.0.0.1:2",
      label: "smoke warm-up",
      deadlineMs: 100,
      backoffMs: 0,
      now: clock.now,
      sleep: async () => {},
      fetchImpl: fakeFetch as typeof fetch,
    }).then(() => null, (err: Error) => err);

    expect(error?.message).toContain("smoke warm-up");
    expect(error?.message).toContain("never became ready");
    expect(error?.message).toContain("within 120ms");
    expect(deletes.map(d => d.table).sort()).toEqual(["Agent", "Memory"]);
  }, 5_000);
});

describe("the job summary claim is enforced (flair#3052)", () => {
  const originalSummary = process.env.GITHUB_STEP_SUMMARY;
  afterEach(() => {
    if (originalSummary === undefined) delete process.env.GITHUB_STEP_SUMMARY;
    else process.env.GITHUB_STEP_SUMMARY = originalSummary;
  });

  test("a real summary file receives the measured duration", () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-3052-summary-"));
    try {
      const file = join(dir, "summary.md");
      process.env.GITHUB_STEP_SUMMARY = file;
      expect(recordStepSummary("unit label", { elapsedMs: 1_234, attempts: 2 })).toBe(true);
      expect(readFileSync(file, "utf8")).toBe(
        "- unit label: embedding model ready in 1234 ms after 2 attempt(s)\n",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an absent summary file is a no-op", () => {
    delete process.env.GITHUB_STEP_SUMMARY;
    expect(recordStepSummary("unit label", { elapsedMs: 1, attempts: 1 })).toBe(false);
  });

  test("a supplied summary path that cannot be written fails by name", () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-3052-summary-"));
    try {
      process.env.GITHUB_STEP_SUMMARY = dir;
      expect(() => recordStepSummary("unit label", { elapsedMs: 1, attempts: 1 }))
        .toThrow(/could not append the embedding-readiness duration to GITHUB_STEP_SUMMARY/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
