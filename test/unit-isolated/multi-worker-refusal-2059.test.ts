import { beforeEach, describe, expect, it, mock } from "bun:test";

let credentialReads = 0;
let tableReads = 0;
let workerCountValue: number | undefined = 1;
let workerCountThrows = false;
let configThreadsCount: number | undefined = undefined;
let loggerErrors: string[] = [];
const httpEntries: Array<{ handler: unknown; options: unknown }> = [];

mock.module("harper", () => {
  const noop = () => {};
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
        if (workerCountThrows) throw new Error("workerCount getter failed");
        return workerCountValue;
      },
      config: {
        threads: {
          get count() {
            return configThreadsCount;
          },
        },
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

function setCondition(
  workerCount: number | undefined,
  optIn: boolean,
  throws = false,
  configCount: number | undefined = undefined,
): void {
  workerCountValue = workerCount;
  workerCountThrows = throws;
  configThreadsCount = configCount;
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

describe("worker condition", () => {
  it("decides known counts", () => {
    expect(guard.decideMultiWorkerState(1, false)).toBe("single-worker");
    expect(guard.decideMultiWorkerState(0, false)).toBe("single-worker");
    expect(guard.decideMultiWorkerState(2, false)).toBe("refused");
    expect(guard.decideMultiWorkerState(8, false)).toBe("refused");
  });

  it("refuses unreadable count", () => {
    expect(guard.decideMultiWorkerState(null, false)).toBe("refused");
  });

  it("handles unsafe opt-in", () => {
    expect(guard.decideMultiWorkerState(2, true)).toBe("unsafe-opt-in");
  });

  it("reads opt-in value", () => {
    expect(guard.multiWorkerUnsafeOptIn({})).toBe(false);
    expect(guard.multiWorkerUnsafeOptIn({ FLAIR_MULTI_WORKER_UNSAFE: "1" })).toBe(true);
    expect(guard.multiWorkerUnsafeOptIn({ FLAIR_MULTI_WORKER_UNSAFE: "true" })).toBe(false);
    expect(guard.multiWorkerUnsafeOptIn({ FLAIR_MULTI_WORKER_UNSAFE: "0" })).toBe(false);
  });

  it("handles unreadable counts", () => {
    setCondition(undefined, false);
    expect(guard.readWorkerCount()).toBeNull();
    expect(guard.multiWorkerCondition()).toEqual({ state: "refused", workerCount: null });
    setCondition(1, false);
    expect(guard.readWorkerCount()).toBe(1);
  });

  it("uses configured count fallback", () => {
    setCondition(undefined, false, false, 2);
    expect(guard.readWorkerCount()).toBe(2);
    expect(guard.multiWorkerCondition()).toEqual({ state: "refused", workerCount: 2 });
    setCondition(undefined, false, false, 1);
    expect(guard.readWorkerCount()).toBe(1);
    expect(guard.multiWorkerCondition()).toEqual({ state: "single-worker", workerCount: 1 });
  });

  it("rejects fractional workerCount", () => {
    setCondition(1.5, false);
    expect(guard.readWorkerCount()).toBeNull();
    expect(guard.multiWorkerCondition()).toEqual({ state: "refused", workerCount: null });
  });

  it("rejects fractional configured count", () => {
    setCondition(undefined, false, false, 1.5);
    expect(guard.readWorkerCount()).toBeNull();
    expect(guard.multiWorkerCondition()).toEqual({ state: "refused", workerCount: null });
  });

  it("handles throwing workerCount getter", () => {
    setCondition(1, false, true);
    expect(guard.readWorkerCount()).toBeNull();
    expect(guard.multiWorkerCondition()).toEqual({ state: "refused", workerCount: null });
    setCondition(1, false, false);
    expect(guard.readWorkerCount()).toBe(1);
  });

  it("uses fallback after getter error", () => {
    setCondition(1, false, true, 2);
    expect(guard.readWorkerCount()).toBe(2);
    expect(guard.multiWorkerCondition()).toEqual({ state: "refused", workerCount: 2 });
    setCondition(1, false, true, 1);
    expect(guard.readWorkerCount()).toBe(1);
    expect(guard.multiWorkerCondition()).toEqual({ state: "single-worker", workerCount: 1 });
  });

  it("builds Health fields", () => {
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

  it("emits boot line", () => {
    expect(guard.multiWorkerBootLine({ state: "single-worker", workerCount: 1 })).toBeNull();
    const line = guard.multiWorkerBootLine({ state: "refused", workerCount: 2 }) ?? "";
    expect(line).toContain("worker count=2");
    expect(line).toContain("THREADS_COUNT=1");

    loggerErrors = [];
    guard.announceMultiWorkerCondition({ state: "refused", workerCount: 2 });
    expect(loggerErrors.filter((l) => l.includes("THREADS_COUNT=1")).length).toBe(1);
  });

  it("describes unreadable and opt-in states", () => {
    const refused = guard.multiWorkerBootLine({ state: "refused", workerCount: null }) ?? "";
    expect(refused).toContain("the worker count is unreadable");
    const optIn = guard.multiWorkerBootLine({ state: "unsafe-opt-in", workerCount: 2 }) ?? "";
    expect(optIn).toContain("FLAIR_MULTI_WORKER_UNSAFE=1");
    expect(optIn.startsWith("[multi-worker] refused")).toBe(false);
  });
});

describe("request guard", () => {
  it("passes single-worker request", async () => {
    setCondition(1, false);
    const res = await middleware(makeRequest("/Presence"), nextLayer);
    expect(res.status).toBe(200);
  });

  it("refuses sampled routes before reads", async () => {
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

  it("refuses unreadable count", async () => {
    setCondition(undefined, false);
    const res = await middleware(makeRequest("/Memory", "GET"), nextLayer);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error?: string; workerCount?: number | null };
    expect(body.error).toBe("multi_worker_unsupported");
    expect(body.workerCount).toBeNull();
  });

  it("refuses fractional count", async () => {
    setCondition(1.5, false);
    const res = await middleware(makeRequest("/Memory", "GET"), nextLayer);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error?: string; workerCount?: number | null };
    expect(body.error).toBe("multi_worker_unsupported");
    expect(body.workerCount).toBeNull();
  });

  it("refuses after count read error", async () => {
    setCondition(1, false, true);
    const res = await middleware(makeRequest("/Memory", "GET"), nextLayer);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error?: string; workerCount?: number | null };
    expect(body.error).toBe("multi_worker_unsupported");
    expect(body.workerCount).toBeNull();
  });

  it("refuses disallowed method", async () => {
    setCondition(2, false);
    const res = await middleware(makeRequest("/Memory", "TRACE"), nextLayer);
    expect(res.status).toBe(503);
    setCondition(1, false);
    const allowed = await middleware(makeRequest("/Memory", "TRACE"), nextLayer);
    expect(allowed.status).toBe(200);
  });

  it("passes Health routes", async () => {
    setCondition(2, false);
    for (const path of ["/Health", "/health"]) {
      const res = await middleware(makeRequest(path), nextLayer);
      expect(res.status).toBe(200);
    }
  });

  it("passes unsafe opt-in request", async () => {
    setCondition(2, true);
    const res = await middleware(makeRequest("/Presence"), nextLayer);
    expect(res.status).toBe(200);
  });
});

describe("Health response", () => {
  it("reports refusal remedy", async () => {
    setCondition(2, false);
    const res = (await new Health().get()) as unknown as Response;
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok?: boolean; multiWorker?: unknown };
    expect(body.ok).toBe(false);
    expect(body.multiWorker).toEqual({ state: "refused", workerCount: 2, remedy: "THREADS_COUNT=1" });
  });

  it("reports unreadable count", async () => {
    setCondition(undefined, false);
    const res = (await new Health().get()) as unknown as Response;
    expect(res.status).toBe(503);
    const body = (await res.json()) as { multiWorker?: unknown };
    expect(body.multiWorker).toEqual({ state: "refused", workerCount: null, remedy: "THREADS_COUNT=1" });
  });

  it("reports unsafe opt-in", async () => {
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

  it("omits field on one worker", async () => {
    setCondition(1, false);
    const body = (await new Health().get()) as unknown as Record<string, unknown>;
    expect("multiWorker" in body).toBe(false);
    expect(body.ok).toBe(true);
  });
});
