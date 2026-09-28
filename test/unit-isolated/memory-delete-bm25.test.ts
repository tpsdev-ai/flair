/**
 * memory-delete-bm25.test.ts — flair#1940 slice 1, round 22 (fix 4).
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
 * Runs in test/unit-isolated (own process) so the BM25 singleton never leaks
 * into the shared unit process. It reuses the shared Memory harper mock.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import {
  harnessState,
  resetHarnessState,
  installMemoryHarperMock,
  databasesMock,
} from "../helpers/memory-search-harness";

process.env.FLAIR_RATE_LIMIT_ENABLED = "false";
delete (process.env as any).FLAIR_PUBLIC;

// The BM25 index service builds from ONE table scan and then rides the table's
// change feed. Give the mock table an inert subscription that STAYS OPEN (a
// closed feed would call disable() and stop the index, so a test could not
// exercise a WARMED index). Patched HERE, not in the shared helper, so the
// shared unit process keeps its pre-existing (feedless) behaviour.
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
    visibility: "shared",
    instanceToken: overrides.instanceToken ?? `tok-${Math.random().toString(36).slice(2)}`,
    ...overrides,
  };
  memoryStore.set(row.id, row);
  return row;
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
