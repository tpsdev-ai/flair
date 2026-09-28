/**
 * memory-delete-bm25.test.ts — flair#1940 slice 1 and flair#2041.
 *
 * The Memory delete joins its pointer delete in ONE shared transaction. The
 * lexical-index delete hook (`noteMemoryDelete`) used to run INSIDE that
 * transaction callback, BEFORE the pointer delete could abort it — so a failed
 * pointer delete left the Memory row in place but marked it deleted in a
 * WARMED BM25 index. The surviving row then vanished from lexical recall.
 *
 * This drives the REAL `Memory.delete` against a WARMED BM25 index (built from
 * one corpus scan, so `noteMemoryDelete` is applied synchronously) and asserts
 * the surviving row is still returned after a pointer-delete failure. RED if
 * the hook is moved back inside the transaction callback.
 *
 * Request-owned deletes must wait for a commit before the feed can remove them
 * from BM25. Runs in test/unit-isolated (own process) so the BM25 singleton
 * never leaks into the shared unit process. It reuses the shared Memory mock.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import {
  harnessState,
  resetHarnessState,
  installMemoryHarperMock,
  databasesMock,
  mockTransaction,
} from "../helpers/memory-search-harness";

process.env.FLAIR_RATE_LIMIT_ENABLED = "false";
delete (process.env as any).FLAIR_PUBLIC;

// Keep the committed feed open. The request tests publish only from mock
// commit(), then await consumption before checking the warmed index.
let emitCommittedDelete: ((id: string) => Promise<void>) | null = null;
(databasesMock.flair.Memory as any).subscribe = () => {
  const events: Array<{ id: string; consumed: () => void }> = [];
  let wake: (() => void) | null = null;
  emitCommittedDelete = (id) => new Promise<void>((consumed) => {
    events.push({ id, consumed });
    wake?.();
  });
  return {
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (events.length === 0) await new Promise<void>((resolve) => { wake = resolve; });
        wake = null;
        while (events.length > 0) {
          const event = events.shift()!;
          yield { type: "delete", id: event.id };
          event.consumed(); // resumes only after BM25 consumed the event
        }
      }
    },
  };
};

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
  emitCommittedDelete = null;
});

describe("flair#2041 — a request-owned delete reaches BM25 only after commit", () => {
  it("commit: the row stays indexed until the request commits, then the feed removes it", async () => {
    const row = seedMemory({ id: "mem-request-commit" });
    expect(await lexicalIds()).toContain(row.id); // warm the real index
    const ctx = { request: { tpsAgent: "agent-a" } } as any;
    const owner = beginRequest(ctx);
    const originalCommit = ctx.transaction.commit;
    let delivered: Promise<void> | null = null;
    ctx.transaction.commit = function () {
      originalCommit.call(this);
      delivered = emitCommittedDelete!(row.id); // committed table change feed
    };

    expect(await memoryWithContext(ctx).delete(row.id)).toEqual({ ok: true });
    expect(memoryStore.has(row.id)).toBe(true); // write is still staged
    expect(await lexicalIds()).toContain(row.id); // no pre-commit notification
    expect(delivered).toBeNull();

    owner.commit();
    await owner.done;
    await delivered;
    expect(memoryStore.has(row.id)).toBe(false);
    expect(await lexicalIds()).not.toContain(row.id);
  });

  it("abort: the surviving row remains in the warmed lexical index", async () => {
    const row = seedMemory({ id: "mem-request-abort" });
    expect(await lexicalIds()).toContain(row.id);
    const ctx = { request: { tpsAgent: "agent-a" } } as any;
    const owner = beginRequest(ctx);

    expect(await memoryWithContext(ctx).delete(row.id)).toEqual({ ok: true });
    expect(await lexicalIds()).toContain(row.id); // still indexed before abort
    owner.abort(new Error("later request failure"));
    await expect(owner.done).rejects.toThrow("later request failure");
    expect(memoryStore.has(row.id)).toBe(true);
    expect(await lexicalIds()).toContain(row.id); // no feed event on abort
  });

  it("owned transaction: a context-less delete notifies after its own commit", async () => {
    const row = seedMemory({ id: "mem-owned-commit" });
    expect(await lexicalIds()).toContain(row.id);
    expect(await memoryWithContext(undefined).delete(row.id)).toEqual({ ok: true });
    expect(memoryStore.has(row.id)).toBe(false);
    expect(await lexicalIds()).not.toContain(row.id); // synchronous owned hook
  });
});

describe("round 22 — (4) a failed pointer delete leaves the row in a WARMED BM25 index", () => {
  it("(r22-delete-bm25) the surviving Memory row is still returned after the shared transaction aborts", async () => {
    const row = seedMemory({ id: "mem-bm25", agentId: "agent-a" });
    pointerStore.set(row.id, {
      memoryId: row.id,
      hostSource: JSON.stringify(POINTER),
      scopeAtWrite: null,
      authorId: "agent-a",
      memoryInstanceToken: row.instanceToken,
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

    // fix 4 (round 22): the lexical index still returns the SURVIVING row.
    const after = await lexicalIds();
    expect(after).toContain("mem-bm25"); // assertion: the surviving row was NOT marked deleted in BM25
  });
});
