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
// Imported AFTER the harper mock is registered, like Memory/MemoryHostSource.
const { MemoryMaintenance } = await import("../../resources/MemoryMaintenance.ts");
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
    expect(asAuthor.hostSource).toEqual(POINTER); // assertion: the author gets the validated object

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
    expect(opted.hostSource).toEqual(POINTER); // assertion: opted-in reader sees it

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
    pointerStore.set(row.id, { memoryId: row.id, hostSource: JSON.stringify(POINTER), scopeAtWrite: null, authorId: "agent-a" });
    await makeMemory(agentCtx("agent-a")).delete(row.id);
    expect(pointerStore.has(row.id)).toBe(false); // assertion: cascade deleted the pointer
  });
});

// ─── A1'' item 1: the whitelist is MEASURED, so shipped attributes survive ────

describe("A1'' item 1 — shipped attributes survive the guarded write", () => {
  it("(w1) a full-row put keeps `type` and the three federation bookkeeping fields", async () => {
    seedMemory({ id: "mem-w1", agentId: "agent-a" });
    const m = makeMemory(agentCtx("agent-a"));
    await m.put({
      id: "mem-w1",
      agentId: "agent-a",
      content: "a short note",
      visibility: "shared",
      type: "session",
      _originatorInstanceId: "inst-orig",
      _syncedFrom: "inst-peer",
      _syncedAt: "2026-01-01T00:00:00.000Z",
    });
    const stored: any = memoryStore.get("mem-w1");
    expect(stored.type).toBe("session"); // assertion: declared `type` kept
    expect(stored._originatorInstanceId).toBe("inst-orig"); // assertion: federation bookkeeping kept
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
    pointerStore.set(row.id, { memoryId: row.id, hostSource: JSON.stringify(POINTER), scopeAtWrite: null, authorId: "agent-a" });

    const asAuthor = await collectSearch("agent-a");
    expect(asAuthor.find((r) => r.id === row.id)?.hostSource).toEqual(POINTER); // assertion: the author sees it
    const asOther = await collectSearch("agent-b");
    expect(asOther.find((r) => r.id === row.id)?.hostSource).toBe("withheld"); // assertion: a non-author is withheld
  });

  it("(j3) a batched multi-row search does ONE pointer query with correct per-row outcomes", async () => {
    const rows = [0, 1, 2].map((i) => seedMemory({ id: `mem-j3-${i}`, agentId: "agent-a", visibility: "shared", provenance: undefined }));
    for (const row of rows) {
      pointerStore.set(row.id, { memoryId: row.id, hostSource: JSON.stringify(POINTER), scopeAtWrite: null, authorId: "agent-a" });
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
    pointerStore.set(row.id, { memoryId: row.id, hostSource: JSON.stringify(POINTER), scopeAtWrite: null, authorId: "agent-a" });
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
    pointerStore.set(row.id, { memoryId: row.id, hostSource: stored, scopeAtWrite: "shared", authorId: "agent-a" });
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
    pointerStore.set(row.id, { memoryId: row.id, hostSource: stored, scopeAtWrite: "shared", authorId: "agent-a" });
    const m = makeMemory(agentCtx("agent-a"));
    await m.put({ id: row.id, agentId: "agent-a", content: "changed", hostSource: changed });
    const after = pointerStore.get(row.id);
    expect(after?.hostSource).toBe(JSON.stringify(changed)); // assertion: the different query is a NEW value, not an echo
    expect(after?.scopeAtWrite).toBe(null); // assertion: no re-opt-in ⇒ author-only (not the old shared)
  });

  it("(e2) a non-author echo does not keep the old pointer (0e)", async () => {
    const stored = JSON.stringify({ v: 1, host: "openclaw", kind: "run", id: "run-bbbbbbbb" });
    const row = seedMemory({ id: "mem-e2", agentId: "agent-b", visibility: "shared" });
    pointerStore.set(row.id, { memoryId: row.id, hostSource: stored, scopeAtWrite: "shared", authorId: "agent-a" });
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
    pointerStore.set("mem-c1", { memoryId: "mem-c1", hostSource: JSON.stringify(POINTER), scopeAtWrite: null, authorId: "agent-a" });
    const out: any = await maint().post({});
    expect(out.archived).toBe(1); // assertion: the archive branch ran
    expect(memoryStore.get("mem-c1")?.archived).toBe(true); // assertion: the row is archived
    expect(pointerStore.has("mem-c1")).toBe(false); // assertion: the pointer row is removed
    const byId: any = await makeMemory(agentCtx("agent-a")).get("mem-c1");
    expect(byId.hostSource).toBeUndefined(); // assertion: the by-id get of the archived row shows no pointer
  });

  it("(c2) the orphan sweep removes a pointer whose Memory is missing", async () => {
    pointerStore.set("mem-orphan", { memoryId: "mem-orphan", hostSource: JSON.stringify(POINTER), scopeAtWrite: null, authorId: "agent-a" });
    const out: any = await maint().post({});
    expect(out.orphans).toBe(1); // assertion: one orphan swept
    expect(pointerStore.has("mem-orphan")).toBe(false); // assertion: the orphan pointer row is gone
  });

  it("(d1) the sweep RE-CHECKS inside the transaction: a row that reappears is not orphan-deleted (0d)", async () => {
    pointerStore.set("mem-d1", { memoryId: "mem-d1", hostSource: JSON.stringify(POINTER), scopeAtWrite: null, authorId: "agent-a" });
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
    pointerStore.set(row.id, { memoryId: row.id, hostSource: JSON.stringify(POINTER), scopeAtWrite: null, authorId: "agent-a" });
    harnessState.failNextPointerDelete = true;
    const r: any = new (Memory as any)();
    r.getContext = () => ({ request: agentCtx("agent-a") }); // request ctx, no transaction
    const res: any = await r.delete("mem-c3");
    expect((res as Response)?.status).toBe(500); // assertion: the delete fails
    expect(memoryStore.has("mem-c3")).toBe(true); // assertion: the Memory row was NOT deleted (transaction aborted)
  });
});
