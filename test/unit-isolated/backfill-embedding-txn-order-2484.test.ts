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
 * Ed25519-signed request, as test/unit/memory-selection-middleware-1940
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
            const current = memoryRows.get(id);
            memoryRows.set(id, { ...current, ...patch });
            return memoryRows.get(id);
          },
          put: async (row: any) => {
            memoryRows.set(row.id, { ...row });
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
    try {
      return await cb();
    } finally {
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
});

const nextLayer = () => new Response("ok", { status: 200 });

async function runBackfill(id: string): Promise<void> {
  const mw = await loadMiddleware();
  // A Memory write reaches the next layer with a 2xx; the middleware then runs
  // backfillEmbedding asynchronously (not awaited by the request).
  const res: Response = await mw(makeRequest(`/Memory/${id}`, "PUT", "agent-a"), nextLayer);
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
