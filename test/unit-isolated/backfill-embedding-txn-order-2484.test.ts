/**
 * backfill-embedding-txn-order-2484.test.ts — the embedding backfill computes
 * its vector OUTSIDE its write transaction (flair#2484).
 *
 * The backfill (`resources/auth-middleware.ts`'s `backfillEmbedding`) used to
 * call the embedding provider from inside the plan callback the shared
 * write-back helper runs while its owned write transaction is open, holding
 * that transaction across the slow model call. It now reads the row and
 * computes the vector before the transaction opens.
 *
 * Isolation: `test/unit-isolated/` — the file owns the `harper` mock and the
 * `embeddings-provider` mock for its own bun process. `auth-middleware.ts` is a
 * side-effect module that calls `server.http(fn)`; the harper mock captures
 * that callback so this file drives the REAL middleware with a REAL
 * Ed25519-signed request, as test/unit-isolated/memory-selection-middleware-1940
 * does, and observes the order in which the model call and the transaction run.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { generateKeyPairSync, randomUUID, sign as edSign } from "node:crypto";
import { agentStore, middlewareCapture } from "../helpers/harper-mock.js";
import { createFakeReplayNonceTable } from "../helpers/fake-replay-store.ts";

process.env.FLAIR_RATE_LIMIT_ENABLED = "false";
delete (process.env as any).FLAIR_PUBLIC;

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUBLIC_B64 = Buffer.from((publicKey.export({ format: "jwk" }) as any).x, "base64url").toString("base64");

// The open-transaction depth the global transaction spy maintains. Whatever
// runs inside a `transaction(ctx, cb)` callback runs with a transaction open.
let txnDepth = 0;
// Every embedding call, with whether a transaction was open when it ran.
const embedCalls: { text: string; txnDepth: number }[] = [];

mock.module("../../resources/embeddings-provider.ts", () => ({
  getEmbedding: async (text: string) => {
    embedCalls.push({ text, txnDepth });
    return [0.11, 0.12, 0.13, 0.14];
  },
  getModelId: () => "mock-embedding-model",
  getMode: () => "local",
  EMBEDDING_ENGINE: "gguf",
}));

const memoryRows = new Map<string, any>();

// Every write the fake Memory table received, by method and the field names it
// named (flair#2494).
const writeCalls: { method: "put" | "update"; id: string; fields: string[] }[] = [];
// The staged writes of the currently-open simulated transaction. A write stages
// here (invisible to a read, as Harper's staged write is) and lands in
// memoryRows when the owning transaction resolves, so the helper's committed
// re-read sees the pre-write row and exactly one update is applied.
let stagedCommits: Map<string, any> = new Map();

function harperMock() {
  return {
    databases: {
      flair: {
        Agent: {
          get: async (id: string) => agentStore.get(id) ?? null,
          search: async function* () {
            for (const a of agentStore.values()) yield a;
          },
        },
        Memory: {
          get: async (id: string) => memoryRows.get(id) ?? null,
          update: async (id: string, patch: Record<string, unknown>) => {
            writeCalls.push({ method: "update", id, fields: Object.keys(patch).sort() });
            const current = memoryRows.get(id);
            const merged = { ...current, ...patch };
            stagedCommits.set(id, merged);
            return merged;
          },
          put: async (row: any) => {
            writeCalls.push({ method: "put", id: row.id, fields: Object.keys(row).sort() });
            stagedCommits.set(row.id, { ...row });
            return row;
          },
        },
        ReplayNonce: createFakeReplayNonceTable(),
      },
    },
    server: {
      getUser: async () => null,
      http: (fn: any) => {
        middlewareCapture.value = fn;
      },
    },
    Resource: class {},
    RequestTarget: class {},
    logger: { warn: () => {}, error: () => {}, info: () => {} },
  };
}

mock.module("harper", harperMock);

function authHeader(agentId: string, method: string, url: string): string {
  const u = new URL(url, "http://localhost");
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const payload = `${agentId}:${ts}:${nonce}:${method}:${u.pathname}${u.search}`;
  const sig = edSign(null, Buffer.from(payload), privateKey);
  return `TPS-Ed25519 ${agentId}:${ts}:${nonce}:${sig.toString("base64")}`;
}

function makeRequest(url: string, method: string, agentId: string): any {
  const headers = new Map<string, string>();
  headers.set("authorization", authHeader(agentId, method, url));
  headers.set("host", "localhost");
  return {
    url,
    method,
    headers: {
      get: (n: string) => headers.get(n.toLowerCase()) ?? null,
      set: (n: string, v: string) => {
        headers.set(n.toLowerCase(), v);
      },
      asObject: {},
    },
  };
}

let authMiddleware: any;
async function loadMiddleware() {
  if (!authMiddleware) {
    mock.module("harper", harperMock);
    await import("../../resources/auth-middleware.ts");
    authMiddleware = middlewareCapture.value;
  }
  return authMiddleware;
}

let savedTransaction: unknown;
beforeAll(() => {
  savedTransaction = (globalThis as { transaction?: unknown }).transaction;
  // The engine-order spy: mark a transaction open for the whole callback, as a
  // real Harper `transaction(ctx, cb)` does.
  (globalThis as { transaction?: unknown }).transaction = async (_ctx: unknown, cb: () => unknown) => {
    txnDepth++;
    const saved = stagedCommits;
    stagedCommits = new Map();
    try {
      const out = await cb();
      for (const [id, row] of stagedCommits) memoryRows.set(id, row);
      return out;
    } finally {
      stagedCommits = saved;
      txnDepth--;
    }
  };
});
afterAll(() => {
  (globalThis as { transaction?: unknown }).transaction = savedTransaction;
});

beforeEach(() => {
  agentStore.clear();
  agentStore.set("agent-a", { id: "agent-a", publicKey: PUBLIC_B64, status: "active", role: "agent" });
  memoryRows.clear();
  embedCalls.length = 0;
  txnDepth = 0;
  writeCalls.length = 0;
  stagedCommits = new Map();
});

// A Harper-shaped write result carrying the committed id: the backfill reads
// the committed id from the writer's own response body (flair#2263), so the
// next layer must return it for the backfill to run.
const resultLayer = (id: string) => () => ({ status: 200, headers: { get: () => null }, body: JSON.stringify({ id, written: true }) } as any);

async function runBackfill(id: string): Promise<void> {
  const mw = await loadMiddleware();
  // A Memory write reaches the next layer with a 2xx; the middleware then runs
  // backfillEmbedding asynchronously (not awaited by the request).
  const res: any = await mw(makeRequest(`/Memory/${id}`, "PUT", "agent-a"), resultLayer(id));
  expect(res.status, "the write was passed to the next layer").toBe(200);
  // Wait for the provider call and a stored embedding, each up to its deadline.
  const deadline = Date.now() + 5_000;
  while (embedCalls.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5));
  }
  const writeDeadline = Date.now() + 5_000;
  while (!(memoryRows.get(id)?.embedding?.length > 0) && Date.now() < writeDeadline) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("flair#2484 — the embedding backfill computes its vector outside the write transaction", () => {
  it("calls the embedding provider while NO transaction is open, and still stores the vector", async () => {
    const id = "bfx-txn-order";
    memoryRows.set(id, { id, agentId: "agent-a", content: "text to embed", contentHash: id, instanceToken: "tok" });

    await runBackfill(id);

    expect(embedCalls.length, "the backfill did not call the embedding provider").toBeGreaterThan(0);
    // The behaviour assertion: no embedding call ran with a transaction open.
    expect(
      embedCalls.map((c) => c.txnDepth),
      "the embedding model was called with a write transaction open (flair#2484)",
    ).toEqual(embedCalls.map(() => 0));
    // And the vector still landed.
    expect(memoryRows.get(id)?.embedding, "the backfill did not store the vector").toEqual([0.11, 0.12, 0.13, 0.14]);
  });

  it("records the transaction-open state as a non-zero control (the spy sees an open transaction)", async () => {
    // CONTROL for the spy: a value written inside the global transaction helper
    // reads as an open transaction, so a zero from the test above is meaningful.
    let observed = -1;
    await (globalThis as any).transaction({}, async () => {
      observed = txnDepth;
    });
    expect(observed, "the transaction spy did not report an open transaction").toBe(1);
    expect(txnDepth, "the spy did not close the transaction").toBe(0);
  });
});

describe("flair#2494 — the backfill's plan shape is pinned", () => {
  it("stores the vector with exactly one incremental update naming only the embedding fields, never a full-row put", async () => {
    const id = "bfx-plan-shape";
    memoryRows.set(id, { id, agentId: "agent-a", content: "text to embed", contentHash: id, instanceToken: "tok" });
    await runBackfill(id);
    // flair#2465: the write also records the hash of the text it embedded;
    // flair#2573: and stamps the vector with the current model id.
    expect(writeCalls).toEqual([{ method: "update", id, fields: ["embeddedContentHash", "embedding", "embeddingModel"] }]);
    expect(memoryRows.get(id)?.embeddingModel).toBe("mock-embedding-model");
  });
});

describe("flair#2573 — the backfill stamps its vector and notifies the embedding-space guard", () => {
  /** Drive one backfill and wait until its stamp has landed and `settled` holds. */
  async function backfillUntil(id: string, settled: () => boolean): Promise<void> {
    const mw = await loadMiddleware();
    const res: any = await mw(makeRequest(`/Memory/${id}`, "PUT", "agent-a"), resultLayer(id));
    expect(res.status).toBe(200);
    const deadline = Date.now() + 5_000;
    while (!(memoryRows.get(id)?.embeddingModel === "mock-embedding-model" && settled()) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  it("a vectorless row is stamped and the verdict stays uniform; replacing an untrusted vector marks the count stale", async () => {
    const guard = await import("../../resources/embedding-space-guard.ts");
    guard._resetGuardForTests();
    guard._setGuardModelIdForTests(() => "mock-embedding-model");
    guard._setGuardTableGetterForTests(async () => ({
      search: async function* () { for (const row of memoryRows.values()) yield row; },
    }));
    try {
      const plain = "bfx-guard-vectorless";
      memoryRows.set(plain, { id: plain, agentId: "agent-a", content: "text to embed", contentHash: plain, instanceToken: "tok" });
      expect(await guard.recomputeLatch()).toBe(true);
      await backfillUntil(plain, () => true);
      expect(memoryRows.get(plain)?.embedding).toEqual([0.11, 0.12, 0.13, 0.14]);
      expect(memoryRows.get(plain)?.embeddingModel).toBe("mock-embedding-model");
      // The stamped vector cannot change the count: the published verdict stands,
      // and a fresh scan agrees with it.
      expect(guard.spaceGuardState()).toEqual({ state: "uniform", reason: null, excluded: 0 });
      expect(await guard.recomputeLatch()).toBe(true);

      const untrusted = "bfx-guard-untrusted";
      memoryRows.set(untrusted, { id: untrusted, agentId: "agent-a", content: "other text", contentHash: untrusted,
        instanceToken: "tok", embedding: [1, 0], embeddingModel: null });
      expect(await guard.recomputeLatch()).toBe(false);
      expect(guard.spaceGuardState()).toEqual({ state: "excluded", reason: null, excluded: 1 });
      await backfillUntil(untrusted, () => guard.spaceGuardState().state !== "excluded");
      // The replaced row stored an untrusted vector: the notification marks the
      // published count stale, and a fresh scan finds none.
      expect(memoryRows.get(untrusted)?.embeddingModel).toBe("mock-embedding-model");
      expect(guard.spaceGuardState()).toEqual({ state: "unverified", reason: null, excluded: 1 });
      expect(await guard.recomputeLatch()).toBe(true);
      expect(guard.spaceGuardState()).toEqual({ state: "uniform", reason: null, excluded: 0 });
    } finally {
      guard._resetGuardForTests();
    }
  });
});
