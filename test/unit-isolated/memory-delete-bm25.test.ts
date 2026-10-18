import { describe, it, expect, beforeEach, spyOn } from "bun:test";
import {
  harnessState,
  resetHarnessState,
  installMemoryHarperMock,
  databasesMock,
  mockTransaction,
} from "../helpers/memory-search-harness";

process.env.FLAIR_RATE_LIMIT_ENABLED = "false";
delete (process.env as any).FLAIR_PUBLIC;

(databasesMock.flair.Memory as any).subscribe = () => ({
  async *[Symbol.asyncIterator]() {
    await new Promise<void>(() => {});
  },
});

const { Memory, _resetLocalInstanceIdCacheForTests } = await installMemoryHarperMock();
const bm25 = await import("../../resources/bm25-index-service.ts");

const memoryStore = harnessState.memoryStore;
const pointerStore = harnessState.pointerStore;

const POINTER = { v: 1, host: "openclaw", kind: "run", id: "run-aaaaaaaa" };
const NOT_ARCHIVED = { attribute: "archived", comparator: "not_equal", value: true };

function seedMemory(overrides: Record<string, any> = {}) {
  const row = {
    id: overrides.id ?? `mem-${Math.random().toString(36).slice(2)}`,
    agentId: "agent-a",
    content: overrides.content ?? "retrieval corpus index latency ranking",
    contentHash: "h",
    createdAt: "2026-01-01T00:00:00.000Z",
    visibility: "shared",
    instanceToken: overrides.instanceToken ?? `tok-${Math.random().toString(36).slice(2)}`,
    ...overrides,
  };
  memoryStore.set(row.id, row);
  return row;
}

function memoryWithContext(ctx: any) {
  const resource: any = new (Memory as any)();
  resource.getContext = () => ctx;
  return resource;
}

function beginRequest(ctx: any) {
  let commit!: () => void;
  let abort!: (reason: Error) => void;
  const done = mockTransaction(ctx, () => new Promise<void>((resolve, reject) => {
    commit = resolve;
    abort = reject;
  })) as Promise<void>;
  return { commit, abort, done };
}

/** Force the index to build (READY) and return the lexical ids for "retrieval". */
async function lexicalIds(): Promise<string[] | null> {
  return bm25.indexedBm25Ids({
    q: "retrieval",
    conditions: [NOT_ARCHIVED],
    limit: 10,
    ctx: {},
  });
}

beforeEach(() => {
  resetHarnessState();
  _resetLocalInstanceIdCacheForTests();
  bm25.__resetBm25IndexForTests();
});

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("flair#2041 — BM25 removal follows the delete's confirmed owned commit", () => {
  it("keeps the row indexed before owned commit and confirmation, then removes it with the request still open", async () => {
    const row = seedMemory({ id: "mem-owned-boundaries" });
    expect(await lexicalIds()).toContain(row.id);
    const ctx = { request: { tpsAgent: "agent-a" } } as any;
    const owner = beginRequest(ctx);
    const requestTransaction = ctx.transaction;
    const staged = gate();
    const allowCommit = gate();
    const confirming = gate();
    const allowConfirmation = gate();
    const originalTransaction = (globalThis as any).transaction;
    (globalThis as any).transaction = async (shared: any, cb: (txn: any) => any) => {
      const result = await mockTransaction(shared, async (txn) => {
        const value = await cb(txn);
        staged.resolve();
        await allowCommit.promise;
        return value;
      });
      return result;
    };
    const originalGet = databasesMock.flair.Memory.get;
    const confirmationRead = spyOn(databasesMock.flair.Memory, "get").mockImplementation(async (id?: any) => {
      if (id === row.id && !memoryStore.has(row.id)) {
        confirming.resolve();
        await allowConfirmation.promise;
      }
      return originalGet(id);
    });
    const deletion = memoryWithContext(ctx).delete(row.id);
    try {
      await staged.promise;
      expect(ctx.transaction).not.toBe(requestTransaction);
      expect(memoryStore.has(row.id)).toBe(true);
      expect(await lexicalIds()).toContain(row.id);
      allowCommit.resolve();
      await confirming.promise;
      expect(memoryStore.has(row.id)).toBe(false);
      expect(await lexicalIds()).toContain(row.id);
      allowConfirmation.resolve();
      expect(await deletion).toBe(true);
      expect(ctx.transaction).toBe(requestTransaction);
      expect(requestTransaction.open).toBe(1);
      expect(await lexicalIds()).not.toContain(row.id);
    } finally {
      allowCommit.resolve();
      allowConfirmation.resolve();
      await deletion;
      confirmationRead.mockRestore();
      (globalThis as any).transaction = originalTransaction;
      owner.commit();
      await owner.done;
    }
  });

  it("keeps the row indexed through compensated attempts and a delete_not_applied refusal", async () => {
    const row = seedMemory({ id: "mem-unapplied", durability: "persistent" });
    const pointer = {
      memoryId: row.id, hostSource: JSON.stringify(POINTER), scopeAtWrite: null,
      authorId: row.agentId, memoryInstanceToken: row.instanceToken,
      receivedAt: row.createdAt,
    };
    pointerStore.set(row.id, pointer);
    expect(await lexicalIds()).toContain(row.id);
    const historyTable = databasesMock.flair.MemoryDeletionHistory;
    let historiesRemoved = 0;
    (databasesMock.flair as any).MemoryDeletionHistory = {
      put: historyTable.put,
      get: async (id: string) => harnessState.deletionStore.get(id) ?? null,
      delete: async (id: string, ctx: any) => {
        expect(harnessState.deletionStore.has(id)).toBe(true);
        ctx.transaction.staged.push(() => {
          harnessState.deletionStore.delete(id);
          historiesRemoved++;
        });
        return true;
      },
    };
    let attempts = 0;
    const droppedRemoval = spyOn(databasesMock.flair.Memory, "delete").mockImplementation(async () => {
      attempts++;
      expect(memoryStore.get(row.id)).toEqual(row);
      expect(pointerStore.get(row.id)).toEqual(pointer);
      expect(harnessState.deletionStore.size).toBe(0);
      expect(await lexicalIds()).toContain(row.id);
      return true;
    });
    try {
      const res = await memoryWithContext({ request: { tpsAgent: "agent-a" } }).delete(row.id);
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe("delete_not_applied");
      expect(attempts).toBe(3);
      expect(historiesRemoved).toBe(3);
      expect(memoryStore.get(row.id)).toEqual(row);
      expect(pointerStore.get(row.id)).toEqual(pointer);
      expect(harnessState.deletionStore.size).toBe(0);
      expect(await lexicalIds()).toContain(row.id);
    } finally {
      droppedRemoval.mockRestore();
      (databasesMock.flair as any).MemoryDeletionHistory = historyTable;
    }
  });

  it("owned transaction: a context-less delete notifies after its own commit", async () => {
    const row = seedMemory({ id: "mem-owned-commit" });
    expect(await lexicalIds()).toContain(row.id);
    expect(await memoryWithContext(undefined).delete(row.id)).toBe(true);
    expect(memoryStore.has(row.id)).toBe(false);
    expect(await lexicalIds()).not.toContain(row.id); // synchronous owned hook
  });
});

describe("a failed pointer delete leaves the row in a warmed BM25 index", () => {
  it("the surviving Memory row is still returned after the owned transaction aborts", async () => {
    const row = seedMemory({ id: "mem-bm25", agentId: "agent-a" });
    pointerStore.set(row.id, {
      memoryId: row.id,
      hostSource: JSON.stringify(POINTER),
      scopeAtWrite: null,
      authorId: "agent-a",
      memoryInstanceToken: row.instanceToken,
      receivedAt: row.createdAt,
    });

    // CONTROL: after warming, the index actually returns the row.
    const before = await lexicalIds();
    expect(before).toContain("mem-bm25"); // assertion: the warmed index serves the row

    harnessState.failNextPointerDelete = true;
    const r: any = new (Memory as any)();
    r.getContext = () => ({ request: { tpsAgent: "agent-a" } }); // request ctx, no transaction
    const res: any = await r.delete("mem-bm25");
    expect(harnessState.failNextPointerDelete).toBe(false); // control: the injected pointer failure fired
    expect((res as Response)?.status).toBe(500); // assertion: the delete fails on the pointer write
    expect(memoryStore.has("mem-bm25")).toBe(true); // assertion: the Memory row survives (transaction aborted)

    const after = await lexicalIds();
    expect(after).toContain("mem-bm25"); // assertion: the surviving row was NOT marked deleted in BM25
  });
});

describe("DELETE checks the identity from the original read", () => {
  for (const initiallyPresent of [true, false]) {
    it(`refuses a row installed before the first owned read (initially present: ${initiallyPresent})`, async () => {
      const original = seedMemory({ id: "mem-first-attempt", instanceToken: "original-token" });
      const replacement = { ...original, instanceToken: "replacement-token", content: "replacement retrieval corpus" };
      if (!initiallyPresent) memoryStore.delete(original.id);
      const originalGet = databasesMock.flair.Memory.get;
      let installed = false;
      const competingRead = spyOn(databasesMock.flair.Memory, "get").mockImplementation(async (id?: any) => {
        if (!installed) {
          installed = true;
          memoryStore.set(original.id, replacement);
        }
        return originalGet(id);
      });
      try {
        const response = await memoryWithContext({ request: { tpsAgent: "agent-a" } }).delete(original.id);
        expect(installed).toBe(true);
        expect(response.status).toBe(409);
        expect((await response.json()).error).toBe("stored_row_changed");
        expect(memoryStore.get(original.id)).toEqual(replacement);
        expect(harnessState.deletionStore.size).toBe(0);
      } finally {
        competingRead.mockRestore();
      }
    });
  }
});
