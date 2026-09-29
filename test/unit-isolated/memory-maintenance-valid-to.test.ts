/**
 * #1503 / #2033: exercise the maintenance pass used by REM light and nightly.
 * In-memory table + mocked auth/index only; no Harper, files or network.
 * Each case includes eligible work so a no-op maintenance pass cannot pass.
 */
import { afterEach, beforeEach, expect, mock, setSystemTime, spyOn, test } from "bun:test";

const NOW = new Date("2026-09-28T12:00:00Z");
const PAST = "2026-09-27T12:00:00Z";
const FUTURE = "2026-09-29T12:00:00Z";
const OLD = "2026-01-01T00:00:00Z";
const AGENT = "fixture-agent";

type Row = { id: string; agentId: string; content: string; [key: string]: unknown };
const rows = new Map<string, Row>();
const pointers = new Map<string, { memoryId: string }>();
type Transaction = { open: number; saveCommits: boolean };
type Context = { transaction?: Transaction };
let requestTransaction: Transaction;
let failingPointerId: string | undefined;
const events: string[] = [];
const originalTransaction = (globalThis as any).transaction;

// Exercise the real owned-transaction helper with rollback-capable tables.
// An existing request transaction must be detached and restored by maintenance.
const transaction = mock(async (ctx: Context, cb: (txn: Transaction) => unknown) => {
  expect(ctx.transaction).toBeUndefined();
  const beforeRows = structuredClone(rows);
  const beforePointers = structuredClone(pointers);
  const txn = { open: 1, saveCommits: false };
  ctx.transaction = txn;
  try {
    const result = await cb(txn);
    events.push("commit");
    return result;
  } catch (error) {
    rows.clear();
    pointers.clear();
    for (const [id, row] of beforeRows) rows.set(id, row);
    for (const [id, pointer] of beforePointers) pointers.set(id, pointer);
    events.push("abort");
    throw error;
  } finally {
    txn.open = 0;
  }
});
function expectOwned(ctx: Context) {
  expect(ctx?.transaction?.open).toBe(1);
  expect(ctx?.transaction).not.toBe(requestTransaction);
}
const deletePointer = mock(async (id: string, ctx: Context) => {
  expectOwned(ctx);
  events.push(`pointer:${id}`);
  if (id === failingPointerId) throw new Error("fixture pointer delete failed");
  pointers.delete(id);
});
let failingId: string | undefined;
const update = mock(async (id: string, row: Row, ctx: Context) => {
  expectOwned(ctx);
  events.push(`update:${id}`);
  if (id === failingId) throw new Error("fixture update failed");
  if (!rows.has(id)) throw new Error("update requires an existing row");
  rows.set(id, structuredClone(row));
});
const remove = mock(async (id: string, ctx: Context) => {
  expectOwned(ctx);
  rows.delete(id);
});
const noteMemoryUpsert = mock((row: Row) => { events.push(`upsert:${row.id}`); });
const noteMemoryDelete = mock((_id: string) => {});
mock.module("harper", () => ({
  Resource: class {},
  databases: { flair: { Memory: {
    search: async function* () { for (const row of [...rows.values()]) yield structuredClone(row); },
    get: async (id: string) => rows.get(id),
    update,
    delete: remove,
  }, MemoryHostSource: {
    search: async function* () { yield* [...pointers.values()]; },
    delete: deletePointer,
  } } },
}));
mock.module("../../resources/agent-auth.js", () => ({ isAdmin: async () => false }));
mock.module("../../resources/bm25-index-service.js", () => ({
  noteMemoryUpsert, noteMemoryDelete,
  bm25IndexInRetrievalPath: () => false,
}));
const { MemoryMaintenance } = await import("../../resources/MemoryMaintenance.ts");

function seed(id: string, fields: Record<string, unknown> = {}): Row {
  const row = { id, agentId: AGENT, content: `retained content for ${id}`, ...fields };
  rows.set(id, structuredClone(row));
  return row;
}
async function maintainRaw(data: { dryRun?: boolean; agentId?: string } = {}, admin = true) {
  const resource = new MemoryMaintenance();
  const ctx = { request: { tpsAgent: AGENT, tpsAgentIsAdmin: admin }, transaction: requestTransaction };
  resource.getContext = () => ctx;
  expect(resource.allowCreate()).toBe(true);
  const result = await resource.post(data);
  expect(ctx.transaction).toBe(requestTransaction);
  expect(requestTransaction.open).toBe(1);
  return result;
}
async function maintain(data: { dryRun?: boolean; agentId?: string } = {}, admin = true) {
  const result = await maintainRaw(data, admin);
  if (result instanceof Response) throw new Error(await result.text());
  return result;
}

beforeEach(() => {
  rows.clear();
  pointers.clear();
  events.length = 0;
  requestTransaction = { open: 1, saveCommits: false };
  failingPointerId = undefined;
  transaction.mockClear();
  deletePointer.mockClear();
  (globalThis as any).transaction = transaction;
  failingId = undefined;
  update.mockClear();
  remove.mockClear();
  noteMemoryUpsert.mockClear();
  noteMemoryDelete.mockClear();
  setSystemTime(NOW);
  spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected network access"));
});
afterEach(() => {
  try { expect(globalThis.fetch).not.toHaveBeenCalled(); }
  finally {
    (globalThis as any).transaction = originalTransaction;
    mock.restore();
    setSystemTime();
  }
});

test("archives validTo-expired rows across durability tiers, preserving their data and updating the index", async () => {
  const originals = ["permanent", "persistent", "standard", "ephemeral", undefined].map((durability, i) =>
    seed(`expired-${i}`, { durability, validTo: PAST, tags: ["retained"], embedding: [0.1, 0.2] }));
  const result = await maintain();
  expect(result.archived).toBe(originals.length);
  expect(result.stats.archived).toBe(originals.length);
  expect(result.expired).toBe(0);
  expect(result.errors).toBe(0);
  expect(rows.size).toBe(originals.length);
  expect(update).toHaveBeenCalledTimes(originals.length);
  for (const original of originals) {
    const archived = { ...original, archived: true, archivedAt: NOW.toISOString() };
    expect(rows.get(original.id)).toEqual(archived);
    expect(update).toHaveBeenCalledWith(original.id, archived, expect.any(Object));
    expect(noteMemoryUpsert).toHaveBeenCalledWith(archived);
  }
  expect(remove).not.toHaveBeenCalled();
  expect(noteMemoryDelete).not.toHaveBeenCalled();
});

test("leaves future, equal-to-now, invalid and absent validTo untouched while archiving an expired control", async () => {
  seed("expired", { validTo: PAST });
  const untouched = [FUTURE, NOW.toISOString(), "invalid", undefined].map((validTo, i) =>
    seed(`untouched-${i}`, { validTo }));
  const result = await maintain();
  expect(result.archived).toBe(1);
  expect(rows.get("expired")?.archived).toBe(true);
  for (const row of untouched) expect(rows.get(row.id)).toEqual(row);
  expect(update).toHaveBeenCalledTimes(1);
  expect(remove).not.toHaveBeenCalled();
});

test("does not rearchive existing archives or double-count overlapping session eligibility, including a repeat pass", async () => {
  const archived = seed("already-archived", { validTo: PAST, archived: true, archivedAt: OLD });
  seed("expired", { validTo: PAST });
  seed("both", { validTo: PAST, durability: "standard", type: "session", createdAt: OLD });
  seed("old-session", { durability: "standard", type: "session", createdAt: OLD });
  const first = await maintain();
  expect(first.archived).toBe(3);
  expect(first.stats.archived).toBe(3);
  expect(update).toHaveBeenCalledTimes(3);
  expect(noteMemoryUpsert).toHaveBeenCalledTimes(3);
  expect(rows.get("already-archived")).toEqual(archived);
  expect(update.mock.calls.map(([id]) => id)).toEqual(["expired", "both", "old-session"]);
  const afterFirst = structuredClone([...rows.values()]);
  const second = await maintain();
  expect(second.archived).toBe(0);
  expect(second.stats.archived).toBe(0);
  expect([...rows.values()]).toEqual(afterFirst);
  expect(update).toHaveBeenCalledTimes(3);
  expect(remove).not.toHaveBeenCalled();
});

test("dry-run counts eligible archives once without writing, deleting or notifying the index", async () => {
  seed("expired", { validTo: PAST });
  seed("both", { validTo: PAST, durability: "standard", type: "session", createdAt: OLD });
  seed("already-archived", { validTo: PAST, archived: true, archivedAt: OLD });
  seed("future", { validTo: FUTURE });
  const before = structuredClone([...rows.values()]);
  const result = await maintain({ dryRun: true });
  expect(transaction).not.toHaveBeenCalled();
  expect(deletePointer).not.toHaveBeenCalled();
  expect(result.message).toBe("Dry run complete");
  expect(result.archived).toBe(2);
  expect(result.stats.archived).toBe(2);
  expect(result.expired).toBe(0);
  expect(result.errors).toBe(0);
  expect([...rows.values()]).toEqual(before);
  expect(update).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
  expect(noteMemoryUpsert).not.toHaveBeenCalled();
  expect(noteMemoryDelete).not.toHaveBeenCalled();
});

test("non-admin cleanup uses the authenticated agent even when the body names another agent", async () => {
  seed("own-expired", { validTo: PAST });
  const other = seed("other-expired", { agentId: "other", validTo: PAST });
  const result = await maintain({ agentId: "other" }, false);
  expect(result.archived).toBe(1);
  expect(result.total).toBe(1);
  expect(result.stats.agent).toBe(AGENT);
  expect(rows.get("own-expired")?.archived).toBe(true);
  expect(rows.get(other.id)).toEqual(other);
  expect(update).toHaveBeenCalledTimes(1);
});

test("admin cleanup supports a selected agent and then fleet-wide archival", async () => {
  const own = seed("own-expired", { validTo: PAST });
  seed("other-expired", { agentId: "other", validTo: PAST });
  const selected = await maintain({ agentId: "other" });
  expect(selected.archived).toBe(1);
  expect(selected.stats.agent).toBe("other");
  expect(rows.get(own.id)).toEqual(own);
  expect(rows.get("other-expired")?.archived).toBe(true);
  const fleet = await maintain();
  expect(fleet.archived).toBe(1);
  expect(fleet.stats.agent).toBe("all");
  expect(rows.get(own.id)?.archived).toBe(true);
  expect(update).toHaveBeenCalledTimes(2);
});

test("failed archival is counted as an error, retains the row and allows subsequent archives", async () => {
  const failed = seed("failed", { validTo: PAST });
  seed("succeeds", { validTo: PAST });
  failingId = failed.id;
  const response = await maintainRaw();
  expect(response).toBeInstanceOf(Response);
  expect((response as Response).status).toBe(500);
  const result = await (response as Response).json();
  expect(result.error).toBe("maintenance_incomplete");
  expect(result.errors).toBe(1);
  expect(result.archived).toBe(1);
  expect(result.stats.archived).toBe(1);
  expect(rows.get(failed.id)).toEqual(failed);
  expect(rows.get("succeeds")?.archived).toBe(true);
  expect(noteMemoryUpsert).toHaveBeenCalledTimes(1);
  expect(remove).not.toHaveBeenCalled();
});


test("validTo archival guards attributes, preserves provenance and commits before notifying the index", async () => {
  const provenance = JSON.stringify({ v: 1, verified: { agentId: AGENT }, claimed: { model: "fixture" } });
  const original = seed("expired-with-pointer", {
    validTo: PAST, provenance, instanceToken: "stored-token", visibility: "private",
    hostSource: { v: 1, host: "fixture" }, hostSourceScope: "private", undeclared: "drop",
  });
  pointers.set(original.id, { memoryId: original.id });
  const result = await maintain();
  const { hostSource, hostSourceScope, undeclared, ...retained } = original;
  const archived = { ...retained, archived: true, archivedAt: NOW.toISOString() };
  expect(result.archived).toBe(1);
  expect(result.orphans).toBe(0);
  expect(rows.get(original.id)).toEqual(archived);
  expect(rows.get(original.id)?.provenance).toBe(provenance);
  expect(update).toHaveBeenCalledWith(original.id, archived, expect.any(Object));
  expect(pointers.has(original.id)).toBe(false);
  expect(transaction).toHaveBeenCalledTimes(1);
  expect(events).toEqual([
    `update:${original.id}`, `pointer:${original.id}`, "commit", `upsert:${original.id}`,
  ]);
  expect(noteMemoryDelete).not.toHaveBeenCalled();
});

test("a validTo pointer-delete failure rolls back only that archive and later rows still commit", async () => {
  const failed = seed("failed-pointer", { validTo: PAST, provenance: "stored-provenance" });
  const succeeds = seed("succeeds", { validTo: PAST });
  pointers.set(failed.id, { memoryId: failed.id });
  pointers.set(succeeds.id, { memoryId: succeeds.id });
  failingPointerId = failed.id;
  const response = await maintainRaw();
  expect(response).toBeInstanceOf(Response);
  expect((response as Response).status).toBe(500);
  const result = await (response as Response).json();
  expect(result.error).toBe("maintenance_incomplete");
  expect(result.errors).toBe(1);
  expect(result.archived).toBe(1);
  expect(result.orphans).toBe(0);
  expect(rows.get(failed.id)).toEqual(failed);
  expect(pointers.has(failed.id)).toBe(true);
  expect(rows.get(succeeds.id)?.archived).toBe(true);
  expect(pointers.has(succeeds.id)).toBe(false);
  expect(noteMemoryUpsert).toHaveBeenCalledTimes(1);
  expect(noteMemoryUpsert).toHaveBeenCalledWith(rows.get(succeeds.id));
  expect(events).toEqual([
    `update:${failed.id}`, `pointer:${failed.id}`, "abort",
    `update:${succeeds.id}`, `pointer:${succeeds.id}`, "commit", `upsert:${succeeds.id}`,
  ]);
});
