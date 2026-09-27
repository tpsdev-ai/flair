/**
 * memory-host-source.test.ts — flair#1940 slice 1 (A1'). Handler-level tests:
 * they drive the REAL resource methods (Memory.post/put/patch/get/search/delete,
 * the MemoryHostSource resource, and the federation classifier), not only the
 * pure projection. Each is written to go RED under its stated mutation (see the
 * PR body). The harper mock is SHARED with memory-search-scope.test.ts (both
 * import resources/Memory.ts) via test/helpers/memory-search-harness.ts.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { FEDERATION_SYNC_TABLES, classifyRecord, type SyncRecord } from "../../resources/federation-classify.ts";
import {
  harnessState,
  resetHarnessState,
  installMemoryHarperMock,
} from "../helpers/memory-search-harness";

process.env.FLAIR_RATE_LIMIT_ENABLED = "false";
delete (process.env as any).FLAIR_PUBLIC;

const { Memory, MemoryHostSource, _resetLocalInstanceIdCacheForTests } = await installMemoryHarperMock();
const memoryStore = harnessState.memoryStore;
const pointerStore = harnessState.pointerStore;

const POINTER = { v: 1, host: "openclaw", kind: "run", id: "run-aaaaaaaa" };

function makeMemory(ctxRequest: any) {
  const r: any = new (Memory as any)();
  r.getContext = () => ({ request: ctxRequest });
  return r;
}
function makeTable(ctxRequest: any) {
  const r: any = new (MemoryHostSource as any)();
  r.getContext = () => ({ request: ctxRequest });
  return r;
}
const agentCtx = (agentId: string, isAdmin = false) => ({ tpsAgent: agentId, tpsAgentIsAdmin: isAdmin });
const anonCtx = () => ({ tpsAnonymous: true });

function seedMemory(overrides: Record<string, any> = {}) {
  const row = {
    id: overrides.id ?? `mem-${Math.random().toString(36).slice(2)}`,
    agentId: "agent-a",
    content: "a short note",
    contentHash: "h",
    visibility: "shared",
    provenance: JSON.stringify({ v: 1, verified: { agentId: "agent-a", timestamp: "2026-01-01T00:00:00.000Z", receivedAt: "2026-01-01T00:00:00.000Z" } }),
    ...overrides,
  };
  memoryStore.set(row.id, row);
  return row;
}

beforeEach(() => {
  resetHarnessState();
  _resetLocalInstanceIdCacheForTests();
});

// ─── item 4: the gated join, both directions ────────────────────────────────

describe("A1' — the gated join for Memory.get / Memory.search", () => {
  it("the author gets the pointer; a non-author gets 'withheld' (get and search)", async () => {
    const row = seedMemory();
    pointerStore.set(row.id, { memoryId: row.id, hostSource: JSON.stringify(POINTER), scopeAtWrite: null, authorId: "agent-a" });

    const asAuthor: any = await makeMemory(agentCtx("agent-a")).get(row.id);
    expect(asAuthor.hostSource).toBe(JSON.stringify(POINTER)); // assertion: the author gets the pointer

    const asOther: any = await makeMemory(agentCtx("agent-b")).get(row.id);
    expect(asOther.hostSource).toBe("withheld"); // assertion: a non-author gets withheld

    const searchOther: any[] = [];
    for await (const r of await makeMemory(agentCtx("agent-b")).search()) searchOther.push(r);
    expect(searchOther[0].hostSource).toBe("withheld"); // assertion: search withholds too
  });

  it("opted in (shared at write): a reader gets the pointer; widening after the write does not widen it", async () => {
    const row = seedMemory({ visibility: "shared" });
    pointerStore.set(row.id, { memoryId: row.id, hostSource: JSON.stringify(POINTER), scopeAtWrite: "shared", authorId: "agent-a" });
    const opted: any = await makeMemory(agentCtx("agent-b")).get(row.id);
    expect(opted.hostSource).toBe(JSON.stringify(POINTER)); // assertion: opted-in reader sees it

    // Opted in while PRIVATE, then the record is widened to shared.
    const row2 = seedMemory({ visibility: "shared" });
    pointerStore.set(row2.id, { memoryId: row2.id, hostSource: JSON.stringify(POINTER), scopeAtWrite: "private", authorId: "agent-a" });
    const widened: any = await makeMemory(agentCtx("agent-b")).get(row2.id);
    expect(widened.hostSource).toBe("withheld"); // assertion: widening never widens the pointer
  });

  it("search fetches pointers for the WHOLE result set in ONE query", async () => {
    for (let i = 0; i < 4; i++) seedMemory({ id: `mem-${i}`, agentId: "agent-a", visibility: "shared" });
    harnessState.pointerSearchCalls = 0;
    const out: any[] = [];
    for await (const r of await makeMemory(agentCtx("agent-b")).search()) out.push(r);
    expect(out.length).toBe(4); // assertion: 4 rows
    expect(harnessState.pointerSearchCalls).toBe(1); // assertion: ONE batched pointer query for N results
  });
});

// ─── item 1 & 3: writes move the pointer to the table; patch/feed carry none ──

describe("A1' — writers keep only declared attributes and only post/put write pointers", () => {
  it("post() with a hostSource writes a pointer ROW and NEVER a hostSource field on the Memory row", async () => {
    const m = makeMemory(agentCtx("agent-a"));
    const res: any = await m.post({ content: "a short note", hostSource: POINTER, hostSourceScope: "record" });
    const id = res.id;
    expect(pointerStore.get(id)?.hostSource).toBe(JSON.stringify(POINTER)); // assertion: pointer row written
    expect(pointerStore.get(id)?.authorId).toBe("agent-a"); // assertion: authorId is the principal's
    expect(memoryStore.get(id)?.hostSource).toBeUndefined(); // assertion: no hostSource on the Memory row
  });

  it("a client-supplied hostSourceVisibility is ignored (never a write-time opt-in)", async () => {
    const m = makeMemory(agentCtx("agent-a"));
    const res: any = await m.post({ content: "a short note", hostSource: POINTER, hostSourceVisibility: "shared" });
    expect(pointerStore.get(res.id)?.scopeAtWrite).toBeNull(); // assertion: forged visibility ignored → author-only
  });

  it("PATCH /Memory/<id> {hostSource:…} leaves NO pointer anywhere", async () => {
    const row = seedMemory({ id: "mem-patch" });
    const m = makeMemory(agentCtx("agent-a"));
    // The patch carries a pointer input AND an undeclared attribute: the guard
    // (declared-attributes whitelist) is what drops the undeclared key, and the
    // pointer-input extraction is what drops the pointer keys — both must run.
    await m.patch({ id: row.id, hostSource: POINTER, undeclaredProbe: "SENTINEL", content: "a short note" });
    expect(pointerStore.has(row.id)).toBe(false); // assertion: no pointer row created
    expect(memoryStore.get(row.id)?.hostSource).toBeUndefined(); // assertion: no pointer field on the row
    expect(memoryStore.get(row.id)?.undeclaredProbe).toBeUndefined(); // assertion: the guard dropped the undeclared key
  });
});

// ─── item 2: atomicity ──────────────────────────────────────────────────────

describe("A1' — a failed pointer write fails the whole write", () => {
  it("leaves no Memory row when the pointer store fails", async () => {
    harnessState.failNextPointerPut = true;
    const m = makeMemory(agentCtx("agent-a"));
    const res = await m.post({ id: "mem-atomic", content: "a short note", hostSource: POINTER });
    expect((res as Response)?.status).toBe(500); // assertion: the write fails
    expect(memoryStore.has("mem-atomic")).toBe(false); // assertion: no orphan Memory row
  });
});

// ─── item 3: the table resource is admin-only; authorId is the principal's ──

describe("A1' — the MemoryHostSource resource", () => {
  it("a non-admin GET gets nothing (404) and a non-admin search gets 403", async () => {
    pointerStore.set("mem-1", { memoryId: "mem-1", hostSource: JSON.stringify(POINTER), scopeAtWrite: null, authorId: "agent-a" });
    const byId = await makeTable(agentCtx("agent-b")).get("mem-1");
    expect((byId as Response)?.status).toBe(404); // assertion: nothing
    const search = await makeTable(agentCtx("agent-b")).search();
    expect((search as Response)?.status).toBe(403); // assertion: 403
    const anon = await makeTable(anonCtx()).get("mem-1");
    expect((anon as Response)?.status).toBe(401); // assertion: anonymous denied
  });

  it("an admin GET reads the row", async () => {
    pointerStore.set("mem-1", { memoryId: "mem-1", hostSource: JSON.stringify(POINTER), scopeAtWrite: null, authorId: "agent-a" });
    const row: any = await makeTable(agentCtx("root", true)).get("mem-1");
    expect(row?.hostSource).toBe(JSON.stringify(POINTER)); // assertion: admin sees it
  });

  it("a body-supplied authorId is IGNORED — the principal's is stamped", async () => {
    const t = makeTable(agentCtx("agent-b"));
    const res: any = await t.post({ memoryId: "mem-9", hostSource: POINTER, authorId: "agent-a" });
    expect(pointerStore.get("mem-9")?.authorId).toBe("agent-b"); // assertion: principal stamped, body ignored
    expect(res.authorId).toBe("agent-b");
  });
});

// ─── item 5: federation excludes the table and refuses an inbound pointer ────

describe("A1' — federation", () => {
  it("the sync table set excludes MemoryHostSource", () => {
    expect(FEDERATION_SYNC_TABLES).not.toContain("MemoryHostSource"); // assertion: excluded by mechanism
  });

  it("an inbound MemoryHostSource row is unknown_table; an inbound Memory row carrying a pointer is refused", () => {
    const known = new Set(FEDERATION_SYNC_TABLES);
    const tableRec: SyncRecord = { table: "MemoryHostSource", id: "mem-1", data: {}, updatedAt: "2026-01-01T00:00:00.000Z", originatorInstanceId: "inst-1" };
    expect(classifyRecord(tableRec, "spoke", "inst-1", null, known)).toEqual({ action: "skip", reason: "unknown_table" }); // assertion

    const pointerRec: SyncRecord = { table: "Memory", id: "mem-1", data: { agentId: "agent-a", hostSource: JSON.stringify(POINTER) }, updatedAt: "2026-01-01T00:00:00.000Z", originatorInstanceId: "inst-1" };
    expect(classifyRecord(pointerRec, "spoke", "inst-1", null, known)).toEqual({ action: "skip", reason: "pointer_not_federated" }); // assertion
  });
});

// ─── item 6: cascade ────────────────────────────────────────────────────────

describe("A1' — cascade: delete leaves no pointer row", () => {
  it("Memory.delete() removes the pointer row", async () => {
    const row = seedMemory({ id: "mem-del" });
    pointerStore.set(row.id, { memoryId: row.id, hostSource: JSON.stringify(POINTER), scopeAtWrite: null, authorId: "agent-a" });
    await makeMemory(agentCtx("agent-a")).delete(row.id);
    expect(pointerStore.has(row.id)).toBe(false); // assertion: cascade deleted the pointer
  });
});
