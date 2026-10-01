/**
 * multi-worker-refusal-2059.test.ts — flair#2059, slice S0 of #2052.
 *
 * Until the multi-worker readiness work lands, more than one Harper worker is
 * unsupported: a per-worker embedding engine and BM25 index today, and the XAA
 * `jti` record until flair#2073. This file drives the guard with a FAKE worker
 * count and proves the promises the slice makes:
 *
 *   - one worker serves unchanged (and /Health gains no field);
 *   - more than one worker refuses every route that is not /Health with the one
 *     named 503, BEFORE the rate limiter, any credential read, or any table
 *     access, and AHEAD OF the method allowlist (a disallowed method gets the
 *     503, not a 405);
 *   - an UNREADABLE worker count is refused, never read as one worker;
 *   - the `FLAIR_MULTI_WORKER_UNSAFE=1` opt-in serves while /Health stays non-OK
 *     and names the opt-in.
 *
 * The refused state is enforced by this module's own http entry (see
 * multi-worker-guard.ts); the harper mock captures every `server.http`
 * registration so these cases invoke the guard entry with a fake request. The
 * real-Harper dispatch proof (default AND mounted routes) is
 * test/integration/multi-worker-refusal-2059.test.ts. Module mocks are
 * process-global, so this file runs in its own process (test/unit-isolated).
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";

let credentialReads = 0;
let tableReads = 0;
let workerCountValue: number | undefined = 1;
let loggerErrors: string[] = [];
const httpEntries: Array<{ handler: unknown; options: unknown }> = [];

mock.module("harper", () => {
  const noop = () => {};
  // Every `databases.flair.<Table>.<op>()` call is counted, whatever the table
  // or the op — a broad table-access spy, not one named table.
  const tableStub: any = new Proxy({}, {
    get: (_t, prop) => {
      if (prop === "then") return undefined;
      return (..._args: unknown[]) => { tableReads++; return Promise.resolve(null); };
    },
  });
  const base: any = {
    server: {
      http: (handler: unknown, options: unknown) => {
        httpEntries.push({ handler, options });
      },
      getUser: async () => {
        credentialReads++;
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
    databases: { flair: new Proxy({}, { get: () => tableStub }) },
    Resource: class {},
    logger: {
      info: noop,
      warn: noop,
      error: (message: string) => {
        loggerErrors.push(message);
      },
      debug: noop,
      trace: noop,
    },
  };
  return new Proxy(base, { get: (t, p) => (p in t ? (t as any)[p] : noop) }) as any;
});

const guard = await import("../../resources/multi-worker-guard.ts");
const { Health } = await import("../../resources/health.ts");
// Importing auth-middleware captures its own http entry; the guard entry was
// captured when the guard module loaded above. Order does not matter: the entry
// is found by name.
await import("../../resources/auth-middleware.ts");

const guardEntry = httpEntries.find(
  (e) => (e.options as { name?: string } | undefined)?.name === guard.MULTI_WORKER_GUARD_HTTP_NAME,
);
if (!guardEntry) throw new Error("the multi-worker guard http entry was not registered");
const middleware = guardEntry.handler as (request: unknown, nextLayer: unknown) => Promise<Response>;

const nextLayer = async () => new Response("next", { status: 200 });

function makeRequest(path: string, method = "GET", authorization?: string): any {
  const headers = new Map<string, string>();
  headers.set("host", "localhost");
  if (authorization) headers.set("authorization", authorization);
  return {
    url: `http://localhost${path}`,
    pathname: path,
    method,
    headers: {
      get: (n: string) => headers.get(n.toLowerCase()) ?? null,
      set: (n: string, v: string) => headers.set(n.toLowerCase(), v),
      asObject: {},
    },
  };
}

/** Force the condition the guard resolves next: a fake count and the opt-in. */
function setCondition(workerCount: number | undefined, optIn: boolean): void {
  workerCountValue = workerCount;
  if (optIn) process.env.FLAIR_MULTI_WORKER_UNSAFE = "1";
  else delete process.env.FLAIR_MULTI_WORKER_UNSAFE;
  guard._resetMultiWorkerGuardForTests();
}

beforeEach(() => {
  credentialReads = 0;
  tableReads = 0;
  loggerErrors = [];
  setCondition(1, false);
});

describe("multi-worker condition (pure)", () => {
  it("serves on one worker and refuses on more", () => {
    expect(guard.decideMultiWorkerState(1, false)).toBe("single-worker");
    expect(guard.decideMultiWorkerState(0, false)).toBe("single-worker");
    expect(guard.decideMultiWorkerState(2, false)).toBe("refused");
    expect(guard.decideMultiWorkerState(8, false)).toBe("refused");
  });

  it("refuses an unknown worker count", () => {
    expect(guard.decideMultiWorkerState(null, false)).toBe("refused");
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

  it("reads an unreadable server.workerCount as unknown, never as one", () => {
    setCondition(undefined, false);
    expect(guard.readWorkerCount()).toBeNull();
    expect(guard.multiWorkerCondition()).toEqual({ state: "refused", workerCount: null });
    setCondition(1, false);
    expect(guard.readWorkerCount()).toBe(1);
  });

  it("omits the /Health field on one worker and names the remedy when refusing", () => {
    expect(guard.multiWorkerHealthField({ state: "single-worker", workerCount: 1 })).toBeNull();
    expect(guard.multiWorkerHealthField({ state: "refused", workerCount: 2 })).toEqual({
      state: "refused",
      workerCount: 2,
      remedy: "THREADS_COUNT=1",
    });
    expect(guard.multiWorkerHealthField({ state: "refused", workerCount: null })).toEqual({
      state: "refused",
      workerCount: null,
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

    loggerErrors = [];
    guard.announceMultiWorkerCondition({ state: "refused", workerCount: 2 });
    expect(loggerErrors.filter((l) => l.includes("THREADS_COUNT=1")).length).toBe(1);
  });

  it("names an unreadable count as unreadable, and logs the opt-in as an opt-in", () => {
    const refused = guard.multiWorkerBootLine({ state: "refused", workerCount: null }) ?? "";
    expect(refused).toContain("server.workerCount is unreadable");
    // The opt-in line is an opt-in, not a continuing refusal.
    const optIn = guard.multiWorkerBootLine({ state: "unsafe-opt-in", workerCount: 2 }) ?? "";
    expect(optIn).toContain("FLAIR_MULTI_WORKER_UNSAFE=1");
    expect(optIn.startsWith("[multi-worker] refused")).toBe(false);
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
      tableReads = 0;
      credentialReads = 0;
      // A Basic credential is attached so "before any auth" is a real
      // assertion: the refusal must land without getUser ever being consulted.
      const res = await middleware(makeRequest(path, method, "Basic Zm9vOmJhcg=="), nextLayer);
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error?: string; remedy?: string; workerCount?: number };
      expect(body.error).toBe("multi_worker_unsupported");
      expect(body.remedy).toBe("THREADS_COUNT=1");
      expect(body.workerCount).toBe(2);
      expect(credentialReads).toBe(0);
      expect(tableReads).toBe(0);
    }
  });

  it("refuses an unknown worker count too", async () => {
    setCondition(undefined, false);
    const res = await middleware(makeRequest("/Memory", "GET"), nextLayer);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error?: string; workerCount?: number | null };
    expect(body.error).toBe("multi_worker_unsupported");
    expect(body.workerCount).toBeNull();
  });

  it("refuses BEFORE the method allowlist: a disallowed method gets the 503, not a 405", async () => {
    setCondition(2, false);
    const res = await middleware(makeRequest("/Memory", "TRACE"), nextLayer);
    expect(res.status).toBe(503);
    // On one worker the same request reaches the method allowlist and is 405.
    setCondition(1, false);
    const allowed = await middleware(makeRequest("/Memory", "TRACE"), nextLayer);
    expect(allowed.status).toBe(200); // this entry steps aside; auth-middleware's 405 is a later entry
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

  it("answers 503 with a null count for an unreadable worker count", async () => {
    setCondition(undefined, false);
    const res = (await new Health().get()) as unknown as Response;
    expect(res.status).toBe(503);
    const body = (await res.json()) as { multiWorker?: unknown };
    expect(body.multiWorker).toEqual({ state: "refused", workerCount: null, remedy: "THREADS_COUNT=1" });
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
