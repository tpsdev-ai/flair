/**
 * multi-worker-refusal-2059.test.ts — flair#2059, slice S0 of #2052.
 *
 * Until the multi-worker readiness work lands, two replay guards being
 * per-worker in-memory Maps makes "more than one Harper worker" unsafe: under
 * `server.workerCount > 1` a signed request is no longer bound to a single use,
 * and Linux reaches that state by default. This file drives the guard with a
 * FAKE worker count and proves the three promises the slice makes:
 *
 *   - one worker serves unchanged (and /Health gains no field);
 *   - more than one worker refuses every route that is not /Health with the one
 *     named 503, BEFORE the rate limiter, any credential read, or any table
 *     access, and /Health answers 503 naming `THREADS_COUNT=1`;
 *   - the `FLAIR_MULTI_WORKER_UNSAFE=1` opt-in serves while /Health stays non-OK
 *     and names the opt-in.
 *
 * `auth-middleware.ts` is a side-effect module (it calls `server.http(fn)`); the
 * harper mock captures that callback so these cases invoke the middleware with a
 * fake request. Module mocks are process-global, so this file runs in its own
 * process (test/unit-isolated).
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";

let memoryReads = 0;
let basicAuthCalls = 0;
let workerCountValue: number | undefined = 1;
const loggedErrors: string[] = [];
const middlewareCapture = { value: null as unknown };

mock.module("harper", () => {
  const noop = () => {};
  const base: any = {
    server: {
      http: (fn: unknown) => {
        middlewareCapture.value = fn;
      },
      getUser: async () => {
        basicAuthCalls++;
        return null;
      },
      get workerCount() {
        return workerCountValue;
      },
      resources: {
        get: (name: string) =>
          name === "Memory" || name === "SemanticSearch" ? { Resource: class {} } : undefined,
      },
    },
    databases: {
      flair: {
        Memory: {
          get: async () => {
            memoryReads++;
            return null;
          },
          search: async function* () {
            memoryReads++;
          },
        },
      },
    },
    Resource: class {},
    logger: {
      info: noop,
      warn: noop,
      error: (message: string) => {
        loggedErrors.push(message);
      },
      debug: noop,
      trace: noop,
    },
  };
  return new Proxy(base, { get: (t, p) => (p in t ? (t as any)[p] : noop) }) as any;
});

const guard = await import("../../resources/multi-worker-guard.ts");
const { Health } = await import("../../resources/health.ts");
await import("../../resources/auth-middleware.ts");
const middleware = middlewareCapture.value as (request: unknown, nextLayer: unknown) => Promise<Response>;

const nextLayer = async () => new Response("next", { status: 200 });

function makeRequest(path: string, method = "GET", authorization?: string): any {
  const headers = new Map<string, string>();
  headers.set("host", "localhost");
  if (authorization) headers.set("authorization", authorization);
  return {
    url: `http://localhost${path}`,
    method,
    headers: {
      get: (n: string) => headers.get(n.toLowerCase()) ?? null,
      set: (n: string, v: string) => headers.set(n.toLowerCase(), v),
      asObject: {},
    },
  };
}

/** Force the condition the guard resolves next: a fake count and the opt-in. */
function setCondition(workerCount: number, optIn: boolean): void {
  workerCountValue = workerCount;
  if (optIn) process.env.FLAIR_MULTI_WORKER_UNSAFE = "1";
  else delete process.env.FLAIR_MULTI_WORKER_UNSAFE;
  guard._resetMultiWorkerGuardForTests();
}

beforeEach(() => {
  memoryReads = 0;
  basicAuthCalls = 0;
  loggedErrors.length = 0;
  setCondition(1, false);
});

describe("multi-worker condition (pure)", () => {
  it("serves on one worker and refuses on more", () => {
    expect(guard.decideMultiWorkerState(1, false)).toBe("single-worker");
    expect(guard.decideMultiWorkerState(0, false)).toBe("single-worker");
    expect(guard.decideMultiWorkerState(2, false)).toBe("refused");
    expect(guard.decideMultiWorkerState(8, false)).toBe("refused");
  });

  it("serves on more than one worker only under the opt-in", () => {
    expect(guard.decideMultiWorkerState(2, true)).toBe("unsafe-opt-in");
  });

  it("reads the opt-in only as the exact value 1", () => {
    expect(guard.multiWorkerUnsafeOptIn({})).toBe(false);
    expect(guard.multiWorkerUnsafeOptIn({ FLAIR_MULTI_WORKER_UNSAFE: "1" })).toBe(true);
    expect(guard.multiWorkerUnsafeOptIn({ FLAIR_MULTI_WORKER_UNSAFE: "true" })).toBe(false);
    expect(guard.multiWorkerUnsafeOptIn({ FLAIR_MULTI_WORKER_UNSAFE: "0" })).toBe(false);
  });

  it("omits the /Health field on one worker and names the remedy when refusing", () => {
    expect(guard.multiWorkerHealthField({ state: "single-worker", workerCount: 1 })).toBeNull();
    expect(guard.multiWorkerHealthField({ state: "refused", workerCount: 2 })).toEqual({
      state: "refused",
      workerCount: 2,
      remedy: "THREADS_COUNT=1",
    });
    expect(guard.multiWorkerHealthField({ state: "unsafe-opt-in", workerCount: 4 })).toEqual({
      state: "unsafe-opt-in",
      workerCount: 4,
      remedy: "FLAIR_MULTI_WORKER_UNSAFE=1",
    });
  });

  it("emits one named boot line naming the condition and the remedy, and none on one worker", () => {
    expect(guard.multiWorkerBootLine({ state: "single-worker", workerCount: 1 })).toBeNull();
    const line = guard.multiWorkerBootLine({ state: "refused", workerCount: 2 }) ?? "";
    expect(line).toContain("server.workerCount=2");
    expect(line).toContain("THREADS_COUNT=1");

    loggedErrors.length = 0;
    guard.announceMultiWorkerCondition({ state: "refused", workerCount: 2 });
    expect(loggedErrors.filter((l) => l.includes("THREADS_COUNT=1")).length).toBe(1);
  });
});

describe("request guard (fake worker count)", () => {
  it("serves on one worker", async () => {
    setCondition(1, false);
    const res = await middleware(makeRequest("/Presence"), nextLayer);
    expect(res.status).toBe(200);
  });

  it("refuses every non-/Health route with the named 503 before any auth or table access", async () => {
    setCondition(2, false);
    const routes: Array<[string, string]> = [
      ["/Presence", "GET"],
      ["/Memory", "GET"],
      ["/Memory", "POST"],
      ["/AgentCard", "GET"],
      ["/FederationSync", "POST"],
      ["/OAuthToken", "POST"],
    ];
    for (const [path, method] of routes) {
      memoryReads = 0;
      basicAuthCalls = 0;
      // A Basic credential is attached so "before any auth" is a real
      // assertion: the refusal must land without getUser ever being consulted.
      const res = await middleware(makeRequest(path, method, "Basic Zm9vOmJhcg=="), nextLayer);
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error?: string; remedy?: string; workerCount?: number };
      expect(body.error).toBe("multi_worker_unsupported");
      expect(body.remedy).toBe("THREADS_COUNT=1");
      expect(body.workerCount).toBe(2);
      expect(basicAuthCalls).toBe(0);
      expect(memoryReads).toBe(0);
    }
  });

  it("steps aside for /Health so the resource renders the refusal", async () => {
    setCondition(2, false);
    const res = await middleware(makeRequest("/Health"), nextLayer);
    expect(res.status).toBe(200);
  });

  it("serves under the opt-in", async () => {
    setCondition(2, true);
    const res = await middleware(makeRequest("/Presence"), nextLayer);
    expect(res.status).toBe(200);
  });
});

describe("/Health under the guard", () => {
  it("answers 503 naming THREADS_COUNT=1 when refusing", async () => {
    setCondition(2, false);
    const res = (await new Health().get()) as unknown as Response;
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok?: boolean; multiWorker?: unknown };
    expect(body.ok).toBe(false);
    expect(body.multiWorker).toEqual({ state: "refused", workerCount: 2, remedy: "THREADS_COUNT=1" });
  });

  it("stays non-OK under the opt-in and names the opt-in", async () => {
    setCondition(2, true);
    const res = (await new Health().get()) as unknown as Response;
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok?: boolean; multiWorker?: unknown };
    expect(body.ok).toBe(false);
    expect(body.multiWorker).toEqual({
      state: "unsafe-opt-in",
      workerCount: 2,
      remedy: "FLAIR_MULTI_WORKER_UNSAFE=1",
    });
  });

  it("is unchanged on one worker (no multiWorker field, still ok)", async () => {
    setCondition(1, false);
    const body = (await new Health().get()) as unknown as Record<string, unknown>;
    expect("multiWorker" in body).toBe(false);
    expect(body.ok).toBe(true);
  });
});
