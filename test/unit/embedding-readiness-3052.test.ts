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
  warmCliConfig,
  warmInstanceEmbeddings,
} from "../../scripts/ci/embedding-readiness.mjs";
import {
  HEALTH_POLL_INTERVAL_MS,
  HEALTH_REQUEST_TIMEOUT_MS,
  INSTANCE_RESOLVE_BUDGET_MS,
  resolveFlairInstance,
} from "../smoke/helpers/flair-instance.ts";
import {
  MEMORY_PROVIDER_TIMEOUT_ERROR,
  memoryProviderTimeoutResponse,
} from "../../resources/memory-write-lock.ts";

/**
 * flair#3052 — the readiness wait is bounded by TOTAL ELAPSED TIME.
 *
 * Each provider call ends at the server's own ~20 s bound, so a fixed attempt
 * count gives up at ~62 s however generous the per-attempt budget is. The
 * deadline-arithmetic cases use a virtual clock: an attempt costs
 * PROVIDER_BOUND_MS, and a retry backoff costs EMBEDDING_RETRY_BACKOFF_MS, so
 * that arithmetic is exercised exactly without waiting in real time. The two
 * wall-clock cases (a stalled and a backward `Date.now()`) wait about 80 ms in
 * real time against the default monotonic clock.
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

  test("an HTTP 500 answer fails at once, without retrying", async () => {
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
    expect(error?.message).toContain("answered at or after the 100ms client-side wait bound");
    expect(attempts).toBe(1);
  }, 5_000);

  test("a success exactly at the deadline is not accepted", async () => {
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
        clock.advance(100); // now() === deadline
        return accepted();
      },
    });

    const error = await call.then(() => null, (err: Error) => err);
    expect(error?.message).toContain("never became ready");
    expect(error?.message).toContain("at or after the 100ms client-side wait bound");
    expect(attempts).toBe(1);
  }, 5_000);

  test("a stalled wall clock cannot extend the bound", async () => {
    const realNow = Date.now;
    Date.now = () => 0;
    try {
      const call = awaitEmbeddingReady({
        label: "unit",
        deadlineMs: 50,
        sleep: async () => {},
        log: () => {},
        attempt: async () => {
          await new Promise((done) => setTimeout(done, 80));
          return accepted();
        },
      });
      const error = await call.then(() => null, (err: Error) => err);
      expect(error?.message).toContain("never became ready");
    } finally {
      Date.now = realNow;
    }
  }, 5_000);

  test("a backward wall clock cannot extend the bound", async () => {
    const realNow = Date.now;
    let calls = 0;
    Date.now = () => (calls++ === 0 ? 1_000_000 : 0);
    try {
      const call = awaitEmbeddingReady({
        label: "unit",
        deadlineMs: 50,
        sleep: async () => {},
        log: () => {},
        attempt: async () => {
          await new Promise((done) => setTimeout(done, 80));
          return accepted();
        },
      });
      const error = await call.then(() => null, (err: Error) => err);
      expect(error?.message).toContain("never became ready");
    } finally {
      Date.now = realNow;
    }
  }, 5_000);

  test("the readiness log line reports the measured duration", async () => {
    const clock = virtualClock();
    const lines: string[] = [];
    const result = await awaitEmbeddingReady({
      label: "unit",
      deadlineMs: 5_000,
      now: clock.now,
      sleep: clock.sleep,
      log: (message: string) => lines.push(message),
      attempt: async () => {
        clock.advance(1_000);
        return accepted();
      },
    });

    expect(result).toEqual({ elapsedMs: 1_000, attempts: 1 });
    expect(lines).toEqual(["unit: embedding ready after 1000ms and 1 attempt(s)"]);
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

  function warmFake(
    clock: ReturnType<typeof virtualClock>,
    rowFor: (id: string) => Record<string, unknown>,
    readBackMs = 0,
  ) {
    let memoryId = "";
    const fakeFetch = async (_url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (body?.operation === "insert" && body?.table === "Agent") {
        return new Response("inserted", { status: 200 });
      }
      if (body?.operation === "delete") return new Response("{}", { status: 200 });
      if (body?.operation === "search_by_id") {
        clock.advance(readBackMs);
        return new Response(JSON.stringify([rowFor(memoryId)]), { status: 200 });
      }
      memoryId = String(body.id ?? "");
      clock.advance(60);
      return new Response("{}", { status: 200 });
    };
    return fakeFetch as typeof fetch;
  }

  test("a 2xx write whose row stores no vector is not ready", async () => {
    const clock = virtualClock();
    const error = await warmInstanceEmbeddings({
      baseUrl: "http://127.0.0.1:1",
      opsUrl: "http://127.0.0.1:2",
      label: "unit warm-up",
      deadlineMs: 200,
      backoffMs: 0,
      maxAttempts: 3,
      now: clock.now,
      sleep: clock.sleep,
      log: () => {},
      fetchImpl: warmFake(clock, (id) => ({ id, embedding: null, embeddingModel: null })),
    }).then(() => null, (err: Error) => err);

    expect(error?.message).toContain("never became ready");
    expect(error?.message).toContain("stored no vector");
  }, 5_000);

  test("a 2xx write whose row stores no model stamp is not ready", async () => {
    const clock = virtualClock();
    const error = await warmInstanceEmbeddings({
      baseUrl: "http://127.0.0.1:1",
      opsUrl: "http://127.0.0.1:2",
      label: "unit warm-up",
      deadlineMs: 200,
      backoffMs: 0,
      maxAttempts: 3,
      now: clock.now,
      sleep: clock.sleep,
      log: () => {},
      fetchImpl: warmFake(clock, (id) => ({ id, embedding: [0.1, 0.2], embeddingModel: null })),
    }).then(() => null, (err: Error) => err);

    expect(error?.message).toContain("never became ready");
    expect(error?.message).toContain("stored no embedding model stamp");
  }, 5_000);

  test("a read-back that confirms the row exactly at the deadline is not ready", async () => {
    // PUT /Memory answers 2xx at 60 ms; the read-back confirms a stamped vector
    // but takes 40 ms, so the confirmation lands at now() === deadline.
    const clock = virtualClock();
    let readBacks = 0;
    const base = warmFake(clock, (id) => ({ id, embedding: [0.1, 0.2], embeddingModel: "unit-model" }), 40);
    const counting = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (body?.operation === "search_by_id") readBacks += 1;
      return base(url, init);
    }) as typeof fetch;
    const error = await warmInstanceEmbeddings({
      baseUrl: "http://127.0.0.1:1",
      opsUrl: "http://127.0.0.1:2",
      label: "unit warm-up",
      deadlineMs: 100,
      backoffMs: 0,
      now: clock.now,
      sleep: clock.sleep,
      log: () => {},
      fetchImpl: counting,
    }).then(() => null, (err: Error) => err);

    expect(readBacks).toBe(1);
    expect(clock.elapsed()).toBe(100);
    expect(error?.message).toContain("never became ready");
    expect(error?.message).toContain("confirmed at or after the 100ms client-side wait bound");
  }, 5_000);

  test("a row read back with a vector and a stamp is ready", async () => {
    const clock = virtualClock();
    const result = await warmInstanceEmbeddings({
      baseUrl: "http://127.0.0.1:1",
      opsUrl: "http://127.0.0.1:2",
      label: "unit warm-up",
      deadlineMs: 200,
      backoffMs: 0,
      now: clock.now,
      sleep: clock.sleep,
      log: () => {},
      fetchImpl: warmFake(clock, (id) => ({ id, embedding: [0.1, 0.2], embeddingModel: "unit-model" })),
    });

    expect(result.attempts).toBe(1);
    expect(result.elapsedMs).toBe(60);
  }, 5_000);
});

describe("each attempt's client bound is the time left, rounded up to a whole millisecond (flair#3052)", () => {
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
    let memoryId = "";
    const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (body?.operation === "insert" && body?.table === "Agent") {
        return new Response("inserted", { status: 200 });
      }
      if (body?.operation === "delete") return new Response("{}", { status: 200 });
      if (body?.operation === "search_by_id") {
        return new Response(JSON.stringify([{ id: memoryId, embedding: [0.1, 0.2], embeddingModel: "unit-model" }]), { status: 200 });
      }
      memoryId = String(body.id ?? "");
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
    let memoryId = "";
    const fakeFetch = async (_url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      calls.push(body);
      if (body?.operation === "insert" && body?.table === "Agent") {
        return new Response("inserted", { status: 200 });
      }
      if (body?.operation === "search_by_id") {
        return new Response(JSON.stringify([{ id: memoryId, embedding: [0.1, 0.2], embeddingModel: "unit-model" }]), { status: 200 });
      }
      if (body?.operation === "delete") return new Response("cleanup down", { status: 500 });
      memoryId = String(body.id ?? "");
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

  test("an unset GITHUB_STEP_SUMMARY is a no-op", () => {
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

describe("the CLI takes credentials only from the environment (flair#3052)", () => {
  const SECRET = "s3cret-in-url";

  test("a --base-url carrying a username and password is refused without echoing the password", () => {
    const error = (() => {
      try {
        warmCliConfig(["--base-url", `http://admin:${SECRET}@127.0.0.1:9926`], {});
        return null;
      } catch (err) {
        return err as Error;
      }
    })();
    expect(error?.message).toContain("the base URL (--base-url) must not carry a username or password");
    expect(error?.message).toContain("http://127.0.0.1:9926");
    expect(error?.message).not.toContain(SECRET);
  });

  test("a --ops-url carrying only a username is refused", () => {
    expect(() => warmCliConfig(["--ops-url", "http://admin@127.0.0.1:9925"], {}))
      .toThrow("the ops URL (--ops-url) must not carry a username or password");
  });

  test("an environment URL carrying credentials is refused too", () => {
    expect(() => warmCliConfig([], { FLAIR_URL: `http://admin:${SECRET}@127.0.0.1:9926` }))
      .toThrow("must not carry a username or password");
    expect(() => warmCliConfig([], { FLAIR_OPS_URL: `http://admin:${SECRET}@127.0.0.1:9925` }))
      .toThrow("must not carry a username or password");
  });

  test("credentials come from FLAIR_ADMIN_USER / FLAIR_ADMIN_PASS, defaulting to admin / admin123", () => {
    const decode = (header: string) => Buffer.from(header.replace(/^Basic /, ""), "base64").toString("utf8");
    const fromEnv = warmCliConfig(["--base-url", "http://127.0.0.1:9926"], {
      FLAIR_ADMIN_USER: "ops-user",
      FLAIR_ADMIN_PASS: "ops-pass",
    });
    expect(decode(fromEnv.authHeader)).toBe("ops-user:ops-pass");
    expect(fromEnv.opsUrl).toBe("http://127.0.0.1:9925");
    const defaults = warmCliConfig(["--base-url", "http://127.0.0.1:9926"], {});
    expect(decode(defaults.authHeader)).toBe("admin:admin123");
  });
});

describe("smoke instance resolution is a strict 30 s monotonic bound (flair#3052)", () => {
  const savedUrl = process.env.FLAIR_TEST_URL;
  afterEach(() => {
    if (savedUrl === undefined) delete process.env.FLAIR_TEST_URL;
    else process.env.FLAIR_TEST_URL = savedUrl;
  });

  /**
   * A virtual clock drives the resolver. The fake `/Health` fetch never touches
   * the network: it costs `costMs(requestedTimeoutMs)` virtual ms and then either
   * answers or throws, and it records each request's clamped timeout with the
   * time left when it was requested.
   */
  function resolverHarness(answer: (call: number) => { costMs: (timeoutMs: number) => number; ok: boolean | "throw" }) {
    const clock = virtualClock(5_000);
    const requests: Array<{ timeoutMs: number; leftMs: number }> = [];
    const sleeps: number[] = [];
    let pendingTimeout = 0;
    let calls = 0;
    const deadline = 5_000 + INSTANCE_RESOLVE_BUDGET_MS;
    const fetchImpl = (async (url: string | URL | Request) => {
      calls += 1;
      expect(String(url)).toEndWith("/Health");
      const { costMs, ok } = answer(calls);
      clock.advance(costMs(pendingTimeout));
      if (ok === "throw") {
        const err = new Error("The operation timed out");
        err.name = "TimeoutError";
        throw err;
      }
      return new Response(ok ? "ok" : "starting", { status: ok ? 200 : 503 });
    }) as typeof fetch;
    const run = () => resolveFlairInstance({
      now: clock.now,
      sleep: async (ms: number) => { sleeps.push(ms); clock.advance(ms); },
      fetchImpl,
      timeoutSignal: (ms: number) => {
        pendingTimeout = ms;
        requests.push({ timeoutMs: ms, leftMs: deadline - clock.now() });
        return new AbortController().signal;
      },
    });
    return { clock, requests, sleeps, run, deadline, calls: () => calls };
  }

  test("a /Health that hangs until each client timeout gives up exactly at 30 s", async () => {
    process.env.FLAIR_TEST_URL = "http://127.0.0.1:1";
    // The first call is refused after 999 ms; every later call hangs until its
    // own client timeout. The last request starts with 1001 ms left, so an
    // unclamped 2 s timeout plus a 500 ms pause would end at ~31.5 s.
    const h = resolverHarness((call) => (call === 1
      ? { costMs: () => 999, ok: "throw" }
      : { costMs: (timeoutMs) => timeoutMs, ok: "throw" }));
    const error = await h.run().then(() => null, (err: Error) => err);

    expect(error?.message).toContain("did not respond within 30s");
    expect(h.clock.elapsed()).toBe(INSTANCE_RESOLVE_BUDGET_MS);
    for (const r of h.requests) expect(r.timeoutMs).toBeLessThanOrEqual(Math.min(HEALTH_REQUEST_TIMEOUT_MS, r.leftMs));
    expect(h.requests.at(-1)).toEqual({ timeoutMs: 1_001, leftMs: 1_001 });
  }, 5_000);

  test("a pause is clamped to the time left", async () => {
    process.env.FLAIR_TEST_URL = "http://127.0.0.1:1";
    // Every call is refused after 300 ms: 37 cycles of 800 ms reach 29.6 s, the
    // next refusal lands at 29.9 s, and the pause must shrink to 100 ms.
    const h = resolverHarness(() => ({ costMs: () => 300, ok: "throw" }));
    const error = await h.run().then(() => null, (err: Error) => err);

    expect(error?.message).toContain("did not respond within 30s");
    expect(h.clock.elapsed()).toBe(INSTANCE_RESOLVE_BUDGET_MS);
    expect(h.sleeps.at(-1)).toBe(100);
    for (const ms of h.sleeps) expect(ms).toBeLessThanOrEqual(HEALTH_POLL_INTERVAL_MS);
  }, 5_000);

  test("a 200 that arrives at or after the bound is not accepted", async () => {
    process.env.FLAIR_TEST_URL = "http://127.0.0.1:1";
    // A fetch that ignores its signal and answers 200 at exactly 30 s.
    const h = resolverHarness(() => ({ costMs: () => INSTANCE_RESOLVE_BUDGET_MS, ok: true }));
    const error = await h.run().then(() => null, (err: Error) => err);

    expect(error?.message).toContain("did not respond within 30s");
    expect(h.calls()).toBe(1);
    expect(h.clock.elapsed()).toBe(INSTANCE_RESOLVE_BUDGET_MS);
  }, 5_000);

  test("a 200 inside the bound resolves the instance", async () => {
    process.env.FLAIR_TEST_URL = "http://127.0.0.1:1";
    const h = resolverHarness((call) => ({ costMs: () => 100, ok: call >= 3 }));
    const instance = await h.run();

    expect(instance.baseUrl).toBe("http://127.0.0.1:1");
    expect(h.calls()).toBe(3);
    expect(h.clock.elapsed()).toBe(3 * 100 + 2 * HEALTH_POLL_INTERVAL_MS);
  }, 5_000);
});
