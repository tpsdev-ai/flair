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
let failingId: string | undefined;
const update = mock(async (id: string, row: Row) => {
  if (id === failingId) throw new Error("fixture update failed");
  if (!rows.has(id)) throw new Error("update requires an existing row");
  rows.set(id, structuredClone(row));
});
const remove = mock(async (id: string) => { rows.delete(id); });
const noteMemoryUpsert = mock((_row: Row) => {});
const noteMemoryDelete = mock((_id: string) => {});
mock.module("harper", () => ({
  Resource: class {},
  databases: { flair: { Memory: {
    search: async function* () { for (const row of rows.values()) yield structuredClone(row); },
    update,
    delete: remove,
  } } },
}));
mock.module("../../resources/agent-auth.js", () => ({ isAdmin: async () => false }));
mock.module("../../resources/bm25-index-service.js", () => ({ noteMemoryUpsert, noteMemoryDelete }));
const { MemoryMaintenance } = await import("../../resources/MemoryMaintenance.ts");

function seed(id: string, fields: Record<string, unknown> = {}): Row {
  const row = { id, agentId: AGENT, content: `retained content for ${id}`, ...fields };
  rows.set(id, structuredClone(row));
  return row;
}
async function maintain(data: { dryRun?: boolean; agentId?: string } = {}, admin = true) {
  const resource = new MemoryMaintenance();
  resource.getContext = () => ({ request: { tpsAgent: AGENT, tpsAgentIsAdmin: admin } });
  expect(resource.allowCreate()).toBe(true);
  const result = await resource.post(data);
  if (result instanceof Response) throw new Error(await result.text());
  return result;
}

beforeEach(() => {
  rows.clear();
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
  finally { mock.restore(); setSystemTime(); }
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
    expect(update).toHaveBeenCalledWith(original.id, archived);
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
  const result = await maintain();
  expect(result.errors).toBe(1);
  expect(result.archived).toBe(1);
  expect(result.stats.archived).toBe(1);
  expect(rows.get(failed.id)).toEqual(failed);
  expect(rows.get("succeeds")?.archived).toBe(true);
  expect(noteMemoryUpsert).toHaveBeenCalledTimes(1);
  expect(remove).not.toHaveBeenCalled();
});
