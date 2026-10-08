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
  databasesMock,
} from "../helpers/memory-search-harness";

process.env.FLAIR_RATE_LIMIT_ENABLED = "false";
delete (process.env as any).FLAIR_PUBLIC;

const { Memory, MemoryHostSource, _resetLocalInstanceIdCacheForTests } = await installMemoryHarperMock();
// Imported AFTER the harper mock is registered, like Memory/MemoryHostSource.
const { MemoryMaintenance } = await import("../../resources/MemoryMaintenance.ts");
const { FeedMemories } = await import("../../resources/MemoryFeed.ts");
const { MemoryArchive } = await import("../../resources/MemoryArchive.ts");
const { SemanticSearch } = await import("../../resources/SemanticSearch.ts");
const { storedPointerIds } = await import("../../resources/memory-host-source.ts");
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
    instanceToken: overrides.instanceToken ?? `tok-${Math.random().toString(36).slice(2)}`,
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
    pointerStore.set(row.id, { memoryId: row.id, hostSource: JSON.stringify(POINTER), scopeAtWrite: null, authorId: "agent-a", memoryInstanceToken: memoryStore.get(row.id)?.instanceToken ?? null });

    const asAuthor: any = await makeMemory(agentCtx("agent-a")).get(row.id);
    expect(asAuthor.hostSource).toEqual(POINTER); // assertion: the author gets the validated object

    const asOther: any = await makeMemory(agentCtx("agent-b")).get(row.id);
    expect(asOther.hostSource).toBe("withheld"); // assertion: a non-author gets withheld

    const searchOther: any[] = [];
    for await (const r of await makeMemory(agentCtx("agent-b")).search()) searchOther.push(r);
    expect(searchOther[0].hostSource).toBe("withheld"); // assertion: search withholds too
  });

  it("opted in (shared at write): a reader gets the pointer; widening after the write does not widen it", async () => {
    const row = seedMemory({ visibility: "shared" });
    pointerStore.set(row.id, { memoryId: row.id, hostSource: JSON.stringify(POINTER), scopeAtWrite: "shared", authorId: "agent-a", memoryInstanceToken: memoryStore.get(row.id)?.instanceToken ?? null });
    const opted: any = await makeMemory(agentCtx("agent-b")).get(row.id);
    expect(opted.hostSource).toEqual(POINTER); // assertion: opted-in reader sees it

    // Opted in while PRIVATE, then the record is widened to shared.
    const row2 = seedMemory({ visibility: "shared" });
    pointerStore.set(row2.id, { memoryId: row2.id, hostSource: JSON.stringify(POINTER), scopeAtWrite: "private", authorId: "agent-a", memoryInstanceToken: memoryStore.get(row2.id)?.instanceToken ?? null });
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
//
// A1'' item 2 replaces the compensating delete with the request transaction:
// the pointer row is written with the request CONTEXT, so it stages into the
// SAME transaction as the Memory row (both tables in database flair); on a
// pointer failure the request transaction is ABORTED so NEITHER row commits.
// The unit lane asserts the HANDLER-LEVEL mechanism — the 500 and that the
// request transaction is aborted — and the DB outcome (no Memory row, and a
// byte-identical pre-existing row) is proved against REAL Harper in
// test/repro/host-source-txn-probe.ts, where the transaction actually exists.
// A mock cannot roll back a Map, so a mock assertion on the store would be a
// lie; we assert the abort that the real transaction acts on.

describe("A1' — a failed pointer write aborts the write (0a)", () => {
  it("the NO-CONTEXT path creates a transaction: a failing pointer write leaves no Memory row", async () => {
    harnessState.failNextPointerPut = true;
    const r: any = new (Memory as any)();
    r.getContext = () => ({}); // internal caller: no request context at all
    const res = await r.post({ id: "mem-atomic", content: "a short note", hostSource: POINTER });
    expect((res as Response)?.status).toBe(500); // assertion: the write fails
    expect(memoryStore.has("mem-atomic")).toBe(false); // assertion: the created transaction rolled the Memory row back
    expect(harnessState.pointerStore.has("mem-atomic")).toBe(false); // assertion: no pointer row
  });

  it("a caller-supplied JOINABLE transaction is aborted on a failing pointer write", async () => {
    harnessState.failNextPointerPut = true;
    let aborted = false;
    const r: any = new (Memory as any)();
    r.getContext = () => ({ request: agentCtx("agent-a"), transaction: { open: 1, abort() { aborted = true; } } });
    const res = await r.post({ id: "mem-atomic2", content: "a short note", hostSource: POINTER });
    expect((res as Response)?.status).toBe(500); // assertion: the write fails
    expect(aborted).toBe(true); // assertion: the joined transaction is aborted
  });
});

// ─── item 3: the table resource is admin-only; authorId is the principal's ──

describe("A1' — the MemoryHostSource resource", () => {
  it("a non-admin GET gets nothing (404) and a non-admin search gets 403", async () => {
    pointerStore.set("mem-1", { memoryId: "mem-1", hostSource: JSON.stringify(POINTER), scopeAtWrite: null, authorId: "agent-a", memoryInstanceToken: memoryStore.get("mem-1")?.instanceToken ?? null });
    const byId = await makeTable(agentCtx("agent-b")).get("mem-1");
    expect((byId as Response)?.status).toBe(404); // assertion: nothing
    const search = await makeTable(agentCtx("agent-b")).search();
    expect((search as Response)?.status).toBe(403); // assertion: 403
    const anon = await makeTable(anonCtx()).get("mem-1");
    expect((anon as Response)?.status).toBe(401); // assertion: anonymous denied
  });

  it("an admin GET reads the row", async () => {
    pointerStore.set("mem-1", { memoryId: "mem-1", hostSource: JSON.stringify(POINTER), scopeAtWrite: null, authorId: "agent-a", memoryInstanceToken: memoryStore.get("mem-1")?.instanceToken ?? null });
    const row: any = await makeTable(agentCtx("root", true)).get("mem-1");
    expect(row?.hostSource).toBe(JSON.stringify(POINTER)); // assertion: admin sees it
  });
});

// ─── A1'' item 3: no REST write verbs on the table resource ──────────────────

describe("A1'' item 3 — MemoryHostSource has no REST write verbs", () => {
  it("(r1) a non-admin PUT for another agent's memory is refused and writes nothing", async () => {
    const t = makeTable(agentCtx("agent-b"));
    const res: any = await t.put({ memoryId: "mem-r1", hostSource: POINTER, scopeAtWrite: "shared", authorId: "agent-a" });
    expect((res as Response)?.status).toBe(403); // assertion: refused
    expect(pointerStore.has("mem-r1")).toBe(false); // assertion: nothing written
  });

  it("(r2) an admin PUT is refused too", async () => {
    const t = makeTable(agentCtx("root", true));
    const res: any = await t.put({ memoryId: "mem-r2", hostSource: POINTER });
    expect((res as Response)?.status).toBe(403); // assertion: admin refused too
    expect(pointerStore.has("mem-r2")).toBe(false); // assertion: nothing written
    const p: any = await t.post({ memoryId: "mem-r2", hostSource: POINTER });
    expect((p as Response)?.status).toBe(403); // assertion: post refused too
    expect(pointerStore.has("mem-r2")).toBe(false); // assertion
  });

  it("(r3) PATCH and DELETE are refused", async () => {
    const t = makeTable(agentCtx("root", true));
    const p: any = await t.patch({ memoryId: "mem-r3", scopeAtWrite: "shared" });
    expect((p as Response)?.status).toBe(403); // assertion: patch refused
    const d: any = await t.delete("mem-r3");
    expect((d as Response)?.status).toBe(403); // assertion: delete refused
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
    pointerStore.set(row.id, { memoryId: row.id, hostSource: JSON.stringify(POINTER), scopeAtWrite: null, authorId: "agent-a", memoryInstanceToken: memoryStore.get(row.id)?.instanceToken ?? null });
    await makeMemory(agentCtx("agent-a")).delete(row.id);
    expect(pointerStore.has(row.id)).toBe(false); // assertion: cascade deleted the pointer
  });
});

// ─── A1'' item 1: the whitelist is MEASURED, so shipped attributes survive ────

describe("A1'' item 1 — shipped attributes survive the guarded write", () => {
  it("(w1) a full-row put keeps `type` and the STORED federation bookkeeping, and a client body cannot forge it", async () => {
    seedMemory({
      id: "mem-w1",
      agentId: "agent-a",
      type: "session",
      _originatorInstanceId: "inst-orig",
      _syncedFrom: "inst-peer",
      _syncedAt: "2026-01-01T00:00:00.000Z",
    });
    const m = makeMemory(agentCtx("agent-a"));
    await m.put({
      id: "mem-w1",
      agentId: "agent-a",
      content: "a short note",
      visibility: "shared",
      type: "session",
      // A client body that tries to forge the receiver bookkeeping: it is
      // dropped, and the STORED values stand (flair#1965 r2).
      _originatorInstanceId: "FORGED",
      _syncedFrom: "FORGED",
      _syncedAt: "FORGED",
    });
    const stored: any = memoryStore.get("mem-w1");
    expect(stored.type).toBe("session"); // assertion: declared `type` kept
    expect(stored._originatorInstanceId).toBe("inst-orig"); // assertion: stored bookkeeping kept, forged value ignored
    expect(stored._syncedFrom).toBe("inst-peer"); // assertion
    expect(stored._syncedAt).toBe("2026-01-01T00:00:00.000Z"); // assertion
  });

  it("(w2) MemoryMaintenance still archives a type:'session' record written through the guarded path", async () => {
    const old = new Date(Date.now() - 40 * 24 * 3600_000).toISOString();
    const m = makeMemory(agentCtx("agent-a"));
    const res: any = await m.post({
      agentId: "agent-a",
      content: "an old session note",
      durability: "standard",
      visibility: "private",
      type: "session",
      createdAt: old,
    });
    const id = res.id;
    expect(memoryStore.get(id)?.type).toBe("session"); // assertion: the guard kept the declared `type`

    const maint: any = new (MemoryMaintenance as any)();
    maint.getContext = () => ({ request: { tpsAgent: "agent-a" } });
    const out: any = await maint.post({});
    expect(out.archived).toBe(1); // assertion: the archive branch still sees type === "session"
    expect(memoryStore.get(id)?.archived).toBe(true); // assertion: the row was archived
  });

  it("(w3) the _reindex path strips an undeclared pointer-like field", async () => {
    seedMemory({ id: "mem-w3", agentId: "agent-a", type: "session" });
    const m = makeMemory({}); // internal ctx: the reindex bypass needs no agent actor
    await m.put({
      _reindex: true,
      id: "mem-w3",
      agentId: "agent-a",
      content: "a short note",
      visibility: "shared",
      type: "session",
      undeclaredProbe: "SENTINEL",
      hostSource: POINTER,
    });
    const stored: any = memoryStore.get("mem-w3");
    expect(stored.undeclaredProbe).toBeUndefined(); // assertion: an undeclared pointer-like field is stripped
    expect(stored.hostSource).toBeUndefined(); // assertion: the pointer input is stripped
    expect(stored.type).toBe("session"); // assertion: the declared field is kept
  });
});

// ─── A1'' item 4: the join compares the reader with the pointer row's authorId ──

describe("A1'' item 4 — the join trusts the pointer row's authorId", () => {
  async function collectSearch(agentId: string): Promise<any[]> {
    const out: any[] = [];
    for await (const r of await makeMemory(agentCtx(agentId)).search()) out.push(r);
    return out;
  }

  it("(j2) search returns the author's own pointer and 'withheld' to a non-author", async () => {
    // No provenance on the row — the SemanticSearch default select omits it,
    // so a provenance-based join would withhold the pointer from its own
    // author. The pointer row's authorId is what decides.
    const row = seedMemory({ id: "mem-j2", agentId: "agent-a", visibility: "shared", provenance: undefined });
    pointerStore.set(row.id, { memoryId: row.id, hostSource: JSON.stringify(POINTER), scopeAtWrite: null, authorId: "agent-a", memoryInstanceToken: memoryStore.get(row.id)?.instanceToken ?? null });

    const asAuthor = await collectSearch("agent-a");
    expect(asAuthor.find((r) => r.id === row.id)?.hostSource).toEqual(POINTER); // assertion: the author sees it
    const asOther = await collectSearch("agent-b");
    expect(asOther.find((r) => r.id === row.id)?.hostSource).toBe("withheld"); // assertion: a non-author is withheld
  });

  it("(j3) a batched multi-row search does ONE pointer query with correct per-row outcomes", async () => {
    const rows = [0, 1, 2].map((i) => seedMemory({ id: `mem-j3-${i}`, agentId: "agent-a", visibility: "shared", provenance: undefined }));
    for (const row of rows) {
      pointerStore.set(row.id, { memoryId: row.id, hostSource: JSON.stringify(POINTER), scopeAtWrite: null, authorId: "agent-a", memoryInstanceToken: memoryStore.get(row.id)?.instanceToken ?? null });
    }
    harnessState.pointerSearchCalls = 0;
    const asAuthor = await collectSearch("agent-a");
    expect(harnessState.pointerSearchCalls).toBe(1); // assertion: ONE pointer query for the whole set
    expect(asAuthor.filter((r) => r.hostSource && typeof r.hostSource === "object").length).toBe(3); // assertion: all three pointers for the author
    harnessState.pointerSearchCalls = 0;
    const asOther = await collectSearch("agent-b");
    expect(harnessState.pointerSearchCalls).toBe(1); // assertion: ONE pointer query
    expect(asOther.every((r) => r.hostSource === "withheld")).toBe(true); // assertion: every row withheld for a non-author
  });
});

// ─── A1'' item 5: partial PUT — scopeAtWrite from the effective visibility ─────

describe("A1'' item 5 — partial PUT stamps scopeAtWrite from the effective visibility", () => {
  it("(p1) a PUT that omits visibility takes scopeAtWrite from the existing row", async () => {
    seedMemory({ id: "mem-p1", agentId: "agent-a", visibility: "shared" });
    const m = makeMemory(agentCtx("agent-a"));
    await m.put({ id: "mem-p1", agentId: "agent-a", content: "a short note", hostSource: POINTER, hostSourceScope: "record" });
    expect(pointerStore.get("mem-p1")?.scopeAtWrite).toBe("shared"); // assertion: the existing row's visibility, not null
  });
});

// ─── adjudication A (round 4): a partial PUT must not widen a private record ──

describe("adjudication A — a partial PUT carries the existing visibility into the row", () => {
  it("(p2) a partial PUT of a PRIVATE record keeps it private (stored row + cross-agent read)", async () => {
    seedMemory({ id: "mem-p2", agentId: "agent-a", visibility: "private" });
    const m = makeMemory(agentCtx("agent-a"));
    // Body OMITS visibility (the memory_update full-put shape).
    await m.put({ id: "mem-p2", agentId: "agent-a", content: "still private" });
    expect(memoryStore.get("mem-p2")?.visibility).toBe("private"); // assertion: the STORED row stays private
    const other: any = await makeMemory(agentCtx("agent-b")).get("mem-p2");
    expect((other as Response)?.status).toBe(404); // assertion: a cross-agent read returns nothing
  });
});

// ─── A1'' item 6: round trip — reads return the validated object ──────────────

describe("A1'' item 6 — a read-then-full-put round trip preserves the pointer", () => {
  it("(rt1) get returns the pointer object, and writing the read row back keeps it", async () => {
    const row = seedMemory({ id: "mem-rt1", agentId: "agent-a", visibility: "shared" });
    pointerStore.set(row.id, { memoryId: row.id, hostSource: JSON.stringify(POINTER), scopeAtWrite: null, authorId: "agent-a", memoryInstanceToken: memoryStore.get(row.id)?.instanceToken ?? null });
    const m = makeMemory(agentCtx("agent-a"));

    const read: any = await m.get(row.id);
    expect(read.hostSource).toEqual(POINTER); // assertion: get returns the validated OBJECT, not the stored string

    // A full-row update that writes the read row back (hostSource is the object)
    // must not be refused — the validator accepts the object it returned.
    const res: any = await m.put({ ...read });
    expect((res as Response)?.status).toBeUndefined(); // assertion: not a refusal
    expect(pointerStore.get(row.id)?.hostSource).toBe(JSON.stringify(POINTER)); // assertion: the pointer is preserved
  });

  // adjudication 0e (round 5): the echo is EXACT and author-bound.
  it("(rt2/e0) an author's EXACT echo of the stored pointer keeps it (full URL preserved)", async () => {
    const stored = JSON.stringify({ v: 1, host: "openclaw", kind: "run", id: "run-bbbbbbbb", url: "https://example.com/path?q=1#frag" });
    const row = seedMemory({ id: "mem-rt2", agentId: "agent-a", visibility: "shared" });
    pointerStore.set(row.id, { memoryId: row.id, hostSource: stored, scopeAtWrite: "shared", authorId: "agent-a", memoryInstanceToken: memoryStore.get(row.id)?.instanceToken ?? null });
    const m = makeMemory(agentCtx("agent-a"));
    await m.put({ id: row.id, agentId: "agent-a", content: "unchanged", hostSource: stored }); // exact echo of the stored value
    const after = pointerStore.get(row.id);
    expect(after?.hostSource).toBe(stored); // assertion: the stored pointer (full URL) is unchanged
    expect(after?.scopeAtWrite).toBe("shared"); // assertion: the stored scope is preserved
    const other: any = await makeMemory(agentCtx("agent-b")).get(row.id);
    expect(other.hostSource).not.toBe("withheld"); // assertion: a non-author still sees it
  });

  it("(e1) a DIFFERENT query is NOT an echo — the pointer is replaced (0e)", async () => {
    const stored = JSON.stringify({ v: 1, host: "openclaw", kind: "run", id: "run-bbbbbbbb", url: "https://example.com/path?q=1#frag" });
    const changed = { v: 1, host: "openclaw", kind: "run", id: "run-bbbbbbbb", url: "https://example.com/path?q=2#frag" };
    const row = seedMemory({ id: "mem-e1", agentId: "agent-a", visibility: "shared" });
    pointerStore.set(row.id, { memoryId: row.id, hostSource: stored, scopeAtWrite: "shared", authorId: "agent-a", memoryInstanceToken: memoryStore.get(row.id)?.instanceToken ?? null });
    const m = makeMemory(agentCtx("agent-a"));
    await m.put({ id: row.id, agentId: "agent-a", content: "changed", hostSource: changed });
    const after = pointerStore.get(row.id);
    expect(after?.hostSource).toBe(JSON.stringify(changed)); // assertion: the different query is a NEW value, not an echo
    expect(after?.scopeAtWrite).toBe(null); // assertion: no re-opt-in ⇒ author-only (not the old shared)
  });

  it("(e2) a non-author echo does not keep the old pointer (0e)", async () => {
    const stored = JSON.stringify({ v: 1, host: "openclaw", kind: "run", id: "run-bbbbbbbb" });
    const row = seedMemory({ id: "mem-e2", agentId: "agent-b", visibility: "shared" });
    pointerStore.set(row.id, { memoryId: row.id, hostSource: stored, scopeAtWrite: "shared", authorId: "agent-a", memoryInstanceToken: memoryStore.get(row.id)?.instanceToken ?? null });
    const m = makeMemory(agentCtx("agent-b")); // owns the record, but NOT the stored pointer
    await m.put({ id: row.id, agentId: "agent-b", content: "owned now", hostSource: stored }); // exact value, wrong author
    const after = pointerStore.get(row.id);
    expect(after?.authorId).toBe("agent-b"); // assertion: the pointer is re-stamped to the current writer (not preserved for agent-a)
    expect(after?.scopeAtWrite).toBe(null); // assertion: the old scope is not inherited
  });
});

// ─── A1'' item 2 (cleanup): pointer cascade + orphan sweep ────────────────────

describe("A1'' item 2 — pointer cleanup joins the write and the sweep removes orphans", () => {
  const maint = () => {
    const m: any = new (MemoryMaintenance as any)();
    m.getContext = () => ({ request: { tpsAgent: "agent-a" } });
    return m;
  };

  it("(c1) archiving a session record removes its pointer; a by-id get of the archived row shows none", async () => {
    const old = new Date(Date.now() - 40 * 24 * 3600_000).toISOString();
    seedMemory({ id: "mem-c1", agentId: "agent-a", durability: "standard", visibility: "private", type: "session", createdAt: old });
    pointerStore.set("mem-c1", { memoryId: "mem-c1", hostSource: JSON.stringify(POINTER), scopeAtWrite: null, authorId: "agent-a", memoryInstanceToken: memoryStore.get("mem-c1")?.instanceToken ?? null });
    const out: any = await maint().post({});
    expect(out.archived).toBe(1); // assertion: the archive branch ran
    expect(memoryStore.get("mem-c1")?.archived).toBe(true); // assertion: the row is archived
    expect(pointerStore.has("mem-c1")).toBe(false); // assertion: the pointer row is removed
    const byId: any = await makeMemory(agentCtx("agent-a")).get("mem-c1");
    expect(byId.hostSource).toBeUndefined(); // assertion: the by-id get of the archived row shows no pointer
  });

  it("(c2) the orphan sweep removes a pointer whose Memory is missing", async () => {
    pointerStore.set("mem-orphan", { memoryId: "mem-orphan", hostSource: JSON.stringify(POINTER), scopeAtWrite: null, authorId: "agent-a", memoryInstanceToken: memoryStore.get("mem-orphan")?.instanceToken ?? null });
    const out: any = await maint().post({});
    expect(out.orphans).toBe(1); // assertion: one orphan swept
    expect(pointerStore.has("mem-orphan")).toBe(false); // assertion: the orphan pointer row is gone
  });

  it("(d1) the sweep RE-CHECKS inside the transaction: a row that reappears is not orphan-deleted (0d)", async () => {
    pointerStore.set("mem-d1", { memoryId: "mem-d1", hostSource: JSON.stringify(POINTER), scopeAtWrite: null, authorId: "agent-a", memoryInstanceToken: memoryStore.get("mem-d1")?.instanceToken ?? null });
    let calls = 0;
    // First (outside-txn) read says missing; the re-check (inside the owned
    // transaction) sees a row that reappeared — the read-to-delete counterexample.
    harnessState.getOverride = (id) => { calls++; return calls === 1 ? null : { id, agentId: "agent-a", archived: false }; };
    const out: any = await maint().post({});
    expect(out.orphans).toBe(0); // assertion: the reappeared row is NOT swept
    expect(pointerStore.has("mem-d1")).toBe(true); // assertion: its pointer survives
    harnessState.getOverride = null;
  });

  it("(c3) a failing pointer delete fails the Memory delete and leaves the row (transaction aborted)", async () => {
    const row = seedMemory({ id: "mem-c3", agentId: "agent-a" });
    pointerStore.set(row.id, { memoryId: row.id, hostSource: JSON.stringify(POINTER), scopeAtWrite: null, authorId: "agent-a", memoryInstanceToken: memoryStore.get(row.id)?.instanceToken ?? null });
    harnessState.failNextPointerDelete = true;
    const r: any = new (Memory as any)();
    r.getContext = () => ({ request: agentCtx("agent-a") }); // request ctx, no transaction
    const res: any = await r.delete("mem-c3");
    expect((res as Response)?.status).toBe(500); // assertion: the delete fails
    expect(memoryStore.has("mem-c3")).toBe(true); // assertion: the Memory row was NOT deleted (transaction aborted)
  });
});

// ─── A1-iv item 1: the binding — a server-stamped row incarnation token ───────

describe("A1-iv item 1 — the pointer join binds on the row's instanceToken", () => {
  it("(b1) a deleted-and-recreated id with the SAME client createdAt shows NO pointer", async () => {
    const T = "2026-01-01T00:00:00.000Z";
    const row = seedMemory({ id: "mem-b1", agentId: "agent-a", createdAt: T });
    pointerStore.set("mem-b1", {
      memoryId: "mem-b1", hostSource: JSON.stringify(POINTER), scopeAtWrite: null,
      authorId: "agent-a", memoryInstanceToken: row.instanceToken,
    });
    // Author sees it while the row exists...
    expect((await makeMemory(agentCtx("agent-a")).get("mem-b1") as any).hostSource).toEqual(POINTER);

    // ...then the row dies and is recreated with the SAME id + SAME createdAt
    // but a NEW incarnation token (a new server-generated token).
    memoryStore.delete("mem-b1");
    seedMemory({ id: "mem-b1", agentId: "agent-a", createdAt: T, instanceToken: "tok-reincarnated" });

    const after: any = await makeMemory(agentCtx("agent-a")).get("mem-b1");
    expect(after.hostSource).toBeUndefined(); // assertion: the stale pointer is NOT returned
  });

  it("(b2) an update via put and patch keeps the token and the pointer", async () => {
    const row = seedMemory({ id: "mem-b2", agentId: "agent-a", visibility: "shared" });
    pointerStore.set("mem-b2", {
      memoryId: "mem-b2", hostSource: JSON.stringify(POINTER), scopeAtWrite: "shared",
      authorId: "agent-a", memoryInstanceToken: row.instanceToken,
    });

    const m = makeMemory(agentCtx("agent-a"));
    await m.put({ ...row });
    expect(memoryStore.get("mem-b2")?.instanceToken).toBe(row.instanceToken); // assertion: put preserved the token
    expect((await m.get("mem-b2") as any).hostSource).toEqual(POINTER); // assertion: the pointer still joins

    await m.patch({ id: "mem-b2", agentId: "agent-a", content: "edited" });
    expect(memoryStore.get("mem-b2")?.instanceToken).toBe(row.instanceToken); // assertion: patch preserved the token
    expect((await makeMemory(agentCtx("agent-a")).get("mem-b2") as any).hostSource).toEqual(POINTER); // assertion
  });

  it("(b3) a client-supplied instanceToken is ignored on every writer", async () => {
    const m = makeMemory(agentCtx("agent-a"));
    const res: any = await m.post({ id: "mem-b3", content: "a short note", instanceToken: "forged-token" });
    const stored = memoryStore.get("mem-b3")?.instanceToken;
    expect(stored).not.toBe("forged-token"); // assertion: the forged value is stripped
    expect(typeof stored).toBe("string"); // assertion: the server stamped its own UUID
    expect(stored).toMatch(/^[0-9a-f-]{36}$/); // assertion: a UUID, not the body's value

    const row = seedMemory({ id: "mem-b3b", agentId: "agent-a" });
    await m.put({ ...row, instanceToken: "forged-token" });
    expect(memoryStore.get("mem-b3b")?.instanceToken).toBe(row.instanceToken); // assertion: put preserved the stored token, not the forged one
  });

  it("(b4) an archived row shows no pointer", async () => {
    const row = seedMemory({ id: "mem-b4", agentId: "agent-a", visibility: "shared", archived: true });
    pointerStore.set("mem-b4", {
      memoryId: "mem-b4", hostSource: JSON.stringify(POINTER), scopeAtWrite: "shared",
      authorId: "agent-a", memoryInstanceToken: row.instanceToken,
    });
    const got: any = await makeMemory(agentCtx("agent-a")).get("mem-b4");
    expect(got.hostSource).toBeUndefined(); // assertion: an archived row never joins a pointer
  });

  it("(b5) a row whose agentId changed (admin write) shows no pointer", async () => {
    const row = seedMemory({ id: "mem-b5", agentId: "agent-a", visibility: "shared" });
    pointerStore.set("mem-b5", {
      memoryId: "mem-b5", hostSource: JSON.stringify(POINTER), scopeAtWrite: "shared",
      authorId: "agent-a", memoryInstanceToken: row.instanceToken,
    });
    // Admin re-owns the row to a different agent (authorId !== agentId now).
    const admin: any = new (Memory as any)();
    admin.getContext = () => ({ request: agentCtx("root", true) });
    await admin.put({ ...row, agentId: "agent-b" });
    expect(memoryStore.get("mem-b5")?.agentId).toBe("agent-b"); // assertion: the re-own landed
    const got: any = await makeMemory(agentCtx("agent-b")).get("mem-b5");
    expect(got.hostSource).toBeUndefined(); // assertion: authorId !== agentId ⇒ no pointer
  });
});

// ─── A1-iv item 2: one reader helper / A1-iv item 3: the server-stamped strip ─

describe("A1-iv items 2/3 — one reader helper and one server-stamped strip list", () => {
  it("(r2) only the helper module reads the MemoryHostSource table", () => {
    const { readdirSync, readFileSync } = require("node:fs");
    const { join } = require("node:path");
    const dir = join(import.meta.dir, "..", "..", "resources");
    // memory-host-source.ts is the ONE module that reads the table (loadPointerRows).
    // MemoryHostSource.ts is the admin/operator RESOURCE; MemoryMaintenance.ts is
    // the cleanup (hygiene) path. Memory.ts writes the table on the write path but
    // must not READ it (it goes through the helper). MemoryPurge.ts checks its
    // pointer cleanup through storedPointerIds, which also lives in the helper.
    const offenders: string[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".ts") || name === "memory-host-source.ts") continue;
      const src = readFileSync(join(dir, name), "utf8");
      if (/\bloadPointerRows\b/.test(src)) offenders.push(name);
    }
    expect(offenders).toEqual([]); // assertion: no module outside the helper reads the table
  });

  it("(r2c) storedPointerIds lists the ids that still have a pointer row and fails closed without the table", async () => {
    pointerStore.set("mem-r2c-a", { memoryId: "mem-r2c-a", hostSource: JSON.stringify(POINTER), scopeAtWrite: null, authorId: "agent-a", memoryInstanceToken: "t" });
    expect([...(await storedPointerIds(["mem-r2c-a", "mem-r2c-b"]))]).toEqual(["mem-r2c-a"]); // assertion: only the stored one
    expect((await storedPointerIds([])).size).toBe(0); // assertion: no ids, no rows
    const table = databasesMock.flair.MemoryHostSource;
    (databasesMock.flair as any).MemoryHostSource = undefined;
    try {
      await expect(storedPointerIds(["mem-r2c-a"])).rejects.toThrow("MemoryHostSource table unavailable"); // assertion: never "none left"
    } finally {
      (databasesMock.flair as any).MemoryHostSource = table;
    }
  });

  it("(r2b) Memory.get, Memory.search and SemanticSearch each RUN the pointer helper", async () => {
    // Behavioural, not a source-text check: `harnessState.pointerSearchCalls`
    // counts every pointer-table query, which only the helper (loadPointerRows)
    // issues — so an increment proves the reader actually ran the join.
    const row = seedMemory({ id: "mem-r2b", agentId: "agent-a", visibility: "shared", content: "needle" });
    pointerStore.set("mem-r2b", { memoryId: "mem-r2b", hostSource: JSON.stringify(POINTER), scopeAtWrite: "shared", authorId: "agent-a", memoryInstanceToken: row.instanceToken });

    harnessState.pointerSearchCalls = 0;
    await makeMemory(agentCtx("agent-b")).get("mem-r2b");
    expect(harnessState.pointerSearchCalls).toBeGreaterThan(0); // assertion: Memory.get RUNS the helper

    harnessState.pointerSearchCalls = 0;
    const s: any[] = [];
    for await (const r of await makeMemory(agentCtx("agent-b")).search()) s.push(r);
    expect(harnessState.pointerSearchCalls).toBeGreaterThan(0); // assertion: Memory.search RUNS the helper

    process.env.FLAIR_RETRIEVAL_MODE = "bm25-only";
    try {
      const sem: any = new (SemanticSearch as any)();
      sem.getContext = () => ({ request: agentCtx("agent-b") });
      harnessState.pointerSearchCalls = 0;
      await sem.post({ q: "needle", agentId: "agent-b" });
      expect(harnessState.pointerSearchCalls).toBeGreaterThan(0); // assertion: SemanticSearch RUNS the helper
    } finally {
      delete process.env.FLAIR_RETRIEVAL_MODE;
    }
  });

  it("(s3) a forged provenance is stripped/overwritten on every writer", async () => {
    const m = makeMemory(agentCtx("agent-a"));
    const res: any = await m.post({ id: "mem-s3", content: "x", provenance: '{"forged":true}' });
    expect(memoryStore.get("mem-s3")?.provenance).not.toContain("forged"); // assertion: post overwrites provenance
    const row = seedMemory({ id: "mem-s3b", agentId: "agent-a" });
    await m.patch({ id: "mem-s3b", agentId: "agent-a", content: "y", provenance: '{"forged":true}' });
    expect(memoryStore.get("mem-s3b")?.provenance).not.toContain("forged"); // assertion: patch strips provenance
  });
});

// ─── A3 item 2: the named non-admin reads remove an inline hostSource ─────────

describe("A3 item 2 — every call to projectHostSource removes inline pointer fields; any other response path must remove them independently or exclude them from its selected fields", () => {
  it("(i1) with NO pointer row, another reader gets the row WITHOUT the inline hostSource", async () => {
    // A RAW test path writes the pointer straight onto the Memory row (a
    // supported write never does). No pointer row exists.
    seedMemory({ id: "mem-i1", agentId: "agent-a", visibility: "shared", hostSource: JSON.stringify(POINTER) });
    const got: any = await makeMemory(agentCtx("agent-b")).get("mem-i1");
    expect(got.hostSource).toBeUndefined(); // assertion: inline hostSource removed on get
    const rows: any[] = [];
    for await (const r of await makeMemory(agentCtx("agent-b")).search()) rows.push(r);
    expect(rows.find((r) => r.id === "mem-i1")?.hostSource).toBeUndefined(); // assertion: removed on search too
  });

  it("(i2) with a token-MISMATCHED pointer row, the inline hostSource is still removed", async () => {
    seedMemory({ id: "mem-i2", agentId: "agent-a", visibility: "shared", hostSource: JSON.stringify(POINTER) });
    pointerStore.set("mem-i2", { memoryId: "mem-i2", hostSource: JSON.stringify(POINTER), scopeAtWrite: "shared", authorId: "agent-a", memoryInstanceToken: "TOKEN-MISMATCH" });
    const got: any = await makeMemory(agentCtx("agent-b")).get("mem-i2");
    expect(got.hostSource).toBeUndefined(); // assertion: an unbound pointer ⇒ inline hostSource removed
  });
});

// ─── A3 item 5: semantic search returns the joined pointer ───────────────────

describe("A3 item 5 — SemanticSearch returns the joined pointer to a permitted reader", () => {
  it("(s5) a permitted non-admin reader gets the pointer from a semantic result", async () => {
    const row = seedMemory({ id: "mem-s5", agentId: "agent-a", visibility: "shared", content: "needle" });
    pointerStore.set("mem-s5", { memoryId: "mem-s5", hostSource: JSON.stringify(POINTER), scopeAtWrite: "shared", authorId: "agent-a", memoryInstanceToken: row.instanceToken });
    process.env.FLAIR_RETRIEVAL_MODE = "bm25-only";
    try {
      const sem: any = new (SemanticSearch as any)();
      sem.getContext = () => ({ request: agentCtx("agent-b") });
      const out: any = await sem.post({ q: "needle", agentId: "agent-b" });
      const hit = (out?.results ?? []).find((r: any) => r.id === "mem-s5");
      expect(hit?.hostSource).toEqual(POINTER); // assertion: the gated join rendered the pointer
    } finally {
      delete process.env.FLAIR_RETRIEVAL_MODE;
    }
  });
});

// ─── item 1: a FeedMemories replacement must not widen a stored-private row ──

describe("item 1 — a FeedMemories replacement keeps a stored-private row private", () => {
  it("(f1) a replacement that omits visibility leaves a shared pointer withheld from another reader", async () => {
    // The row is stored PRIVATE; its pointer was stamped when the row was shared.
    seedMemory({ id: "mem-f1", agentId: "agent-a", visibility: "private", content: "note" });
    pointerStore.set("mem-f1", { memoryId: "mem-f1", hostSource: JSON.stringify(POINTER), scopeAtWrite: "shared", authorId: "agent-a", memoryInstanceToken: memoryStore.get("mem-f1")?.instanceToken });

    const feed: any = new (FeedMemories as any)();
    feed.getContext = () => ({ request: agentCtx("agent-a") });
    await feed.post({ id: "mem-f1", agentId: "agent-a", content: "note replaced" });

    expect(memoryStore.get("mem-f1")?.visibility).toBe("private"); // assertion: the carry kept the row private
    // A different ordinary reader must not receive the pointer.
    const got: any = await makeMemory(agentCtx("agent-b")).get("mem-f1");
    const disclosed = got && typeof got === "object" && got.hostSource === POINTER;
    expect(disclosed).toBe(false); // assertion: the pointer stayed withheld from another reader
  });
});

// ─── item 9: archiving must not rewrite the stored pointer ───────────────────

describe("item 9 — archiving a row does not write the projected pointer back", () => {
  it("(ar1) the write-back omits the pointer fields, so the stored pointer keeps its full URL and scope", async () => {
    const fullUrlPointer = { v: 1, host: "openclaw", kind: "run", id: "run-ar1", url: "https://host.example/path?a=1#frag" };
    // The row carries a pointer (a raw write put one inline); its pointer row
    // holds the full URL and a write-time scope.
    seedMemory({ id: "mem-ar1", agentId: "agent-a", visibility: "shared", hostSource: JSON.stringify(fullUrlPointer) });
    pointerStore.set("mem-ar1", { memoryId: "mem-ar1", hostSource: JSON.stringify(fullUrlPointer), scopeAtWrite: "shared", authorId: "agent-a", memoryInstanceToken: memoryStore.get("mem-ar1")?.instanceToken });
    const before = pointerStore.get("mem-ar1")?.hostSource;

    // Capture the payload the archive hands to the write.
    let captured: any = null;
    const realPut = (Memory as any).put;
    (Memory as any).put = async (content: any, ctx: any) => { captured = content; return realPut.call(Memory, content, ctx); };
    try {
      const arch: any = new (MemoryArchive as any)();
      arch.getContext = () => ({ request: agentCtx("agent-a") });
      const res: any = await arch.post({ id: "mem-ar1", action: "basement" });
      expect(res?.archived).toBe(true); // assertion: the archive landed
    } finally {
      (Memory as any).put = realPut;
    }

    expect(captured?.hostSource).toBeUndefined(); // assertion: the write-back omits the inline pointer
    expect(captured?.hostSourceScope).toBeUndefined(); // assertion: and the scope
    expect(pointerStore.get("mem-ar1")?.hostSource).toBe(before); // assertion: the full URL survived
    expect(pointerStore.get("mem-ar1")?.scopeAtWrite).toBe("shared"); // assertion: the scope survived
  });
});


// ─── round 17: the handler reads an UNSHAPED row on the non-admin path ───────
//
// Flint's round-17 design ruling stops honouring a caller's selection on a
// non-admin HTTP Memory read by STRIPPING it from the request URL in the auth
// middleware, before Harper parses it (see memory-selection-middleware-1940
// .test.ts and the real-Harper integration test). At the handler level the
// by-id read-scope gate already reads an UNSHAPED target for a non-admin, and
// hands the caller's target (with its selection) straight through for an admin,
// so the two paths are pinned here.

describe("round 17 — the by-id gate reads unshaped for a non-admin and passthrough for an admin", () => {
  it("(n4) an ADMIN read keeps its selection (control): the caller's target reaches the base read", async () => {
    seedMemory({ id: "mem-n4", agentId: "agent-a", visibility: "shared", content: "body" });
    const res: any = await makeMemory(agentCtx("agent-a", true)).get({ id: "mem-n4", select: ["content"] });
    expect(res instanceof Response).toBe(false); // assertion: an admin read
    expect((harnessState.lastBaseGetTarget as any)?.select).toEqual(["content"]); // assertion: the admin path keeps the selection
  });

  it("(n5) a hostile target constructor cannot shape the non-admin scope read", async () => {
    const row = seedMemory({ id: "mem-n5", agentId: "agent-a", visibility: "private", content: "secret" });
    class PrivateHiding { id: any; select = ["id", "agentId", "content", "instanceToken"]; }
    const t: any = new PrivateHiding();
    t.id = row.id;
    const res: any = await makeMemory(agentCtx("agent-b")).get(t);
    expect(res instanceof Response).toBe(true); // assertion: denied
    expect(res.status).toBe(404); // assertion: the same 404 a missing row gets
  });

});

// ─── round 18: a non-admin contextual read keeps the full-row join boundary ──
//
// Flint's round-18 ruling: whatever target shape reaches Memory.get/search
// in-process, a NON-admin caller gets the gated, pointer-projected row. The
// resource drops a caller selection (a key deletion, never a selection parser)
// so the base read is unselected and the join sees the STORED row — a shaped
// base value could omit `instanceToken`/`visibility`/`archived` and move the
// pointer decision. Admin/trusted-internal reads are unchanged (n4 above).

describe("round 18 — a non-admin contextual read ignores the caller's selection (the join sees the stored row)", () => {
  it("(q1) a non-admin by-id get with a selection returns the FULL gated row; no selection reaches the base read", async () => {
    const row = seedMemory({ id: "mem-q1", agentId: "agent-a", visibility: "shared", content: "full body", subject: "subj" });
    pointerStore.set(row.id, {
      memoryId: row.id, hostSource: JSON.stringify(POINTER), scopeAtWrite: "shared",
      authorId: "agent-a", memoryInstanceToken: row.instanceToken, receivedAt: "2026-01-01T00:00:00.000Z",
    });
    const res: any = await makeMemory(agentCtx("agent-a")).get({ id: row.id, select: ["content"] });
    expect(res instanceof Response).toBe(false); // assertion: the read succeeded
    expect(res.content).toBe("full body"); // assertion: the requested field is there
    expect(res.agentId).toBe("agent-a"); // assertion: an UNselected field is present (full stored row)
    expect(res.instanceToken).toBe(row.instanceToken); // assertion: the join's binding key reached the projection
    expect(res.hostSource).toEqual(POINTER); // assertion: the gated pointer rendered from the STORED row
    expect((harnessState.lastBaseGetTarget as any)?.select).toBeUndefined(); // assertion: no selection reached the base read
  });

  it("(q2) a non-admin collection search with a selection returns FULL rows; the selection is dropped before the base read", async () => {
    const row = seedMemory({ id: "mem-q2", agentId: "agent-a", visibility: "shared", content: "full body" });
    pointerStore.set(row.id, {
      memoryId: row.id, hostSource: JSON.stringify(POINTER), scopeAtWrite: "shared",
      authorId: "agent-a", memoryInstanceToken: row.instanceToken, receivedAt: "2026-01-01T00:00:00.000Z",
    });
    const stream: any = await makeMemory(agentCtx("agent-a")).search({
      conditions: [{ attribute: "agentId", value: "agent-a" }],
      select: ["id"],
    });
    const rows: any[] = [];
    for await (const r of stream) rows.push(r);
    expect(rows.length).toBe(1); // assertion: the scoped read returned the row
    expect(rows[0].agentId).toBe("agent-a"); // assertion: an UNselected field is present (full stored row)
    expect(rows[0].hostSource).toEqual(POINTER); // assertion: the gated pointer rendered from the STORED row
    expect((harnessState.lastBaseSearchQuery as any)?.select).toBeUndefined(); // assertion: no selection reached the base read
  });
});

// ─── round 20: an explicit failure control and verb-level probes ────────────
//
// (1) CONTEXT-LESS INTERNAL WRITE ATOMICITY — request-transaction.ts's
//     withSharedWriteTransaction owns a transaction when the caller carries no
//     joinable one, so a context-less internal create (the docstring's named
//     `new Memory().post(...)`) whose pointer write fails rolls the Memory row
//     back with it. Making the joinability check unconditional (`return
//     fn(shared)`, the owned branch dead) must fail (r20-atomic) below.
// (2) GUARD WIRING AT THE WRITE VERBS — each of the four
//     `stripUndeclaredMemoryAttributes(content)` call sites (Memory.post, the
//     normal Memory.put branch, Memory.put's `_reindex` branch, Memory.patch)
//     drops an undeclared key from the row. Removing any one call must fail the
//     matching verb case below.

describe("round 20 — (1) a CONTEXT-LESS internal create owns its transaction", () => {
  it("(r20-atomic) new Memory().post(...) with NO request context fails its pointer write and commits NO Memory row", async () => {
    harnessState.failNextPointerPut = true;
    const m: any = new (Memory as any)();
    m.getContext = () => ({}); // internal caller: no request context at all — the docstring's named path
    const res: any = await m.post({ id: "mem-r20-atomic", content: "x", hostSource: POINTER, hostSourceScope: "record" });
    // CONTROL, judged BEFORE the rollback claim: the injected failure actually
    // loaded and fired — the one-shot flag was consumed and the 500 IS the
    // pointer-persist failure — so the rollback below can only pass because it did.
    expect(harnessState.failNextPointerPut).toBe(false); // assertion: the injected pointer failure fired
    expect((res as Response)?.status).toBe(500); // assertion: the write failed
    expect((await (res as Response).json()).error).toBe("host_source_persist_failed"); // assertion: it failed on the POINTER write
    expect(memoryStore.has("mem-r20-atomic")).toBe(false); // assertion: the owned transaction rolled the Memory row back
    expect(harnessState.pointerStore.has("mem-r20-atomic")).toBe(false); // assertion: no pointer row
  });
});

describe("round 20 — (2) the guard is wired at each of the four write verbs", () => {
  const UNDECLARED = "undeclaredProbe";
  const clean = (verb: string, id: string) => {
    const stored: any = memoryStore.get(id);
    expect(stored?.[UNDECLARED], `${verb}: undeclared key persisted`).toBeUndefined(); // assertion: no undeclared key on the row
    expect(stored?.hostSource, `${verb}: pointer key persisted`).toBeUndefined(); // assertion: no pointer key on the row
  };

  it("(r20-post) Memory.post — create verb, resources/Memory.ts:1220", async () => {
    const m = makeMemory(agentCtx("agent-a"));
    await m.post({ id: "mem-r20-post", agentId: "agent-a", content: "x", [UNDECLARED]: "SENTINEL", hostSource: POINTER, hostSourceScope: "record" });
    clean("post", "mem-r20-post");
  });

  it("(r20-put) Memory.put — normal create/update branch, resources/Memory.ts:1700", async () => {
    seedMemory({ id: "mem-r20-put", agentId: "agent-a", visibility: "shared" });
    const m = makeMemory(agentCtx("agent-a"));
    await m.put({ id: "mem-r20-put", agentId: "agent-a", content: "x", visibility: "shared", [UNDECLARED]: "SENTINEL", hostSource: POINTER, hostSourceScope: "record" });
    clean("put", "mem-r20-put");
  });

  it("(r20-put-reindex) Memory.put — `_reindex` admin branch, resources/Memory.ts:1370", async () => {
    const seeded = seedMemory({ id: "mem-r20-reindex", agentId: "agent-a", type: "session" });
    const m: any = new (Memory as any)();
    m.getContext = () => ({}); // the _reindex bypass needs no agent actor (admin/internal)
    // The real reindex re-PUTs the WHOLE stored row ({...record, _reindex:true}),
    // provenance included; the writer strips server-stamped fields, so only the
    // explicit STORED-value restore keeps provenance.
    await m.put({ ...seeded, _reindex: true, [UNDECLARED]: "SENTINEL", hostSource: POINTER });
    clean("put(_reindex)", "mem-r20-reindex");
    // fix 1 (round 22): a corpus-wide reindex must not erase provenance.
    expect(memoryStore.get("mem-r20-reindex")?.provenance).toBe(seeded.provenance); // assertion: stored provenance is byte-identical after a full-row re-PUT
  });

  it("(r20-patch) Memory.patch — update verb, resources/Memory.ts:1291", async () => {
    seedMemory({ id: "mem-r20-patch", agentId: "agent-a", visibility: "shared" });
    const m = makeMemory(agentCtx("agent-a"));
    await m.patch({ id: "mem-r20-patch", agentId: "agent-a", content: "x", [UNDECLARED]: "SENTINEL", hostSource: POINTER });
    clean("patch", "mem-r20-patch");
  });
});

// ─── round 22: provenance survival, streaming join, orphan-sweep resilience ──

describe("round 22 — (1) a reindex keeps the STORED provenance", () => {
  it("(r22-reindex-provenance) `_reindex` restores the STORED value, never the submitted one", async () => {
    const seeded = seedMemory({ id: "mem-r22-reindex", agentId: "agent-a", type: "session" });
    const m: any = new (Memory as any)();
    m.getContext = () => ({});
    // A FORGED provenance in the body is stripped; the STORED value is restored.
    await m.put({ _reindex: true, id: "mem-r22-reindex", agentId: "agent-a", content: "x", type: "session", provenance: "FORGED-PROVENANCE" });
    expect(memoryStore.get("mem-r22-reindex")?.provenance).toBe(seeded.provenance); // assertion: the stored provenance survives
    expect(memoryStore.get("mem-r22-reindex")?.provenance).not.toBe("FORGED-PROVENANCE"); // assertion: the submitted value is never restored
  });
});

describe("round 22 — (3) the non-admin pointer join streams in fixed-size chunks", () => {
  it("(r22-search-chunks) a search larger than one chunk yields before source exhaustion and keeps every pointer query bounded", async () => {
    const N = 205; // one 200-row chunk + a 5-row tail
    const ids: string[] = [];
    for (let i = 0; i < N; i++) {
      const id = `mem-chunk-${String(i).padStart(3, "0")}`;
      ids.push(id);
      seedMemory({ id, agentId: "agent-a", visibility: "shared" });
    }
    harnessState.pointerSearchCalls = 0;
    const out: any[] = [];
    let yieldsAtFirstRow = -1;
    for await (const row of await makeMemory(agentCtx("agent-b")).search()) {
      if (out.length === 0) yieldsAtFirstRow = harnessState.baseSearchYields;
      out.push(row);
    }
    // CONTROL: the base source really did hold all N rows.
    expect(out.length).toBe(N); // assertion: every scoped row is returned
    // STREAMING: the first result was produced after reading only the first
    // chunk, NOT after exhausting the whole source (the buffered code reads all
    // N before its first yield).
    expect(yieldsAtFirstRow).toBeLessThan(N); // assertion: yielded before source exhaustion
    expect(yieldsAtFirstRow).toBeLessThanOrEqual(200); // assertion: exactly the first chunk was read
    // BOUNDED: more than one pointer query, and every one is <= the chunk size.
    expect(harnessState.pointerQuerySizes.length).toBeGreaterThan(1); // assertion: the set is processed in chunks
    expect(harnessState.pointerQuerySizes.every((n) => n <= 200)).toBe(true); // assertion: every pointer query is bounded
    // ORDER + PROJECTION preserved.
    expect(out.map((r) => r.id)).toEqual(ids); // assertion: result order is the source order
    expect(out[0].hostSource).toBeUndefined(); // assertion: no pointer field is invented when no pointer row exists
  });
});

describe("round 22 — (5) one orphan's failure does not stop the sweep", () => {
  const maint = () => {
    const m: any = new (MemoryMaintenance as any)();
    m.getContext = () => ({ request: { tpsAgent: "agent-a" } });
    return m;
  };

  it("(r22-orphan-continues) a failing early orphan is counted and the sweep cleans a later one", async () => {
    // Two orphan pointer rows (each with NO Memory row). The FIRST orphan's
    // pointer delete fails; the sweep must count the error and CONTINUE.
    pointerStore.set("mem-orphan-1", { memoryId: "mem-orphan-1", hostSource: JSON.stringify(POINTER), scopeAtWrite: null, authorId: "agent-a", memoryInstanceToken: null });
    pointerStore.set("mem-orphan-2", { memoryId: "mem-orphan-2", hostSource: JSON.stringify(POINTER), scopeAtWrite: null, authorId: "agent-a", memoryInstanceToken: null });
    harnessState.failNextPointerDelete = true;
    const resp: any = await maint().post({});
    // The errors>0 branch returns a 500 Response (the success path returns a
    // plain object), so read the body off the Response.
    expect(resp instanceof Response).toBe(true); // assertion: an incomplete run is a 500, not a silent success
    expect(resp.status).toBe(500);
    const out: any = await resp.json();
    expect(harnessState.failNextPointerDelete).toBe(false); // control: the injected pointer failure fired
    expect(out.error).toBe("maintenance_incomplete"); // assertion: an honest partial, not a generic 500
    expect(out.errors).toBe(1); // assertion: the failed orphan is counted in stats.errors
    expect(out.orphans).toBe(1); // assertion: the later orphan is still swept (counted only after commit)
    expect(pointerStore.has("mem-orphan-1")).toBe(true); // assertion: the failed orphan's pointer survives
    expect(pointerStore.has("mem-orphan-2")).toBe(false); // assertion: the later orphan was cleaned
  });
});


describe("client-forged skillSubjectId", () => {
  it("Memory POST strips skillSubjectId", async () => {
    await makeMemory(agentCtx("agent-a")).post({ id: "skill-strip-post", content: "x", skillSubjectId: "forged-subject" });
    expect(memoryStore.has("skill-strip-post")).toBe(true);
    expect(memoryStore.get("skill-strip-post")?.skillSubjectId).toBeUndefined();
  });

  it("Memory PUT strips skillSubjectId", async () => {
    const row = seedMemory({ id: "skill-strip-put" });
    await makeMemory(agentCtx("agent-a")).put({ ...row, skillSubjectId: "forged-subject" });
    expect(memoryStore.get(row.id)?.content).toBe(row.content);
    expect(memoryStore.get(row.id)?.skillSubjectId).toBeUndefined();
  });

  it("Memory PATCH strips skillSubjectId", async () => {
    const row = seedMemory({ id: "skill-strip-patch" });
    await makeMemory(agentCtx("agent-a")).patch({ id: row.id, content: "edited", skillSubjectId: "forged-subject" });
    expect(memoryStore.get(row.id)?.content).toBe("edited");
    expect(memoryStore.get(row.id)?.skillSubjectId).toBeUndefined();
  });

  it("Memory PUT _reindex strips skillSubjectId", async () => {
    const row = seedMemory({ id: "skill-strip-reindex", type: "session" });
    const m: any = new (Memory as any)();
    m.getContext = () => ({});
    await m.put({ ...row, _reindex: true, skillSubjectId: "forged-subject" });
    expect(memoryStore.get(row.id)?.provenance).toBe(row.provenance);
    expect(memoryStore.get(row.id)?.skillSubjectId).toBeUndefined();
  });

  it("FeedMemories POST strips skillSubjectId", async () => {
    const feed: any = new (FeedMemories as any)();
    feed.getContext = () => ({ request: agentCtx("agent-a") });
    await feed.post({ id: "skill-strip-feed", agentId: "agent-a", content: "x", skillSubjectId: "forged-subject" });
    expect(memoryStore.has("skill-strip-feed")).toBe(true);
    expect(memoryStore.get("skill-strip-feed")?.skillSubjectId).toBeUndefined();
  });
});
