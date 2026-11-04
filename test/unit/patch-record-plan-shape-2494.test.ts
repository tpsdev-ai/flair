/**
 * patch-record-plan-shape-2494.test.ts — the shared lastReflected stamp writer
 * (resources/table-helpers.ts's `patchRecord`, the helper behind Memory.ts's
 * and MemoryReflect.ts's `lastReflected` stamps) writes an incremental update
 * naming only the patch's fields, never a full-row `put` (flair#2470/#2494).
 *
 * The fake table records the method and field names of every write it receives,
 * so an `update` plan that carried the whole row (or a `write` plan) fails the
 * assertion below. Staging models Harper: a write is invisible to a read until
 * its transaction commits, so the helper's committed re-read sees the pre-write
 * row.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { installFakeHarperTransaction } from "../helpers/fake-harper-txn";
import { patchRecord } from "../../resources/table-helpers.js";

type Write = { method: "put" | "update"; id: string; fields: string[] };

let store: Map<string, Record<string, any>>;
let writes: Write[];
let txn: ReturnType<typeof installFakeHarperTransaction>;

function recordingTable() {
  return {
    async get(id: string) {
      const row = store.get(id);
      return row ? { ...row } : null;
    },
    async put(row: Record<string, any>) {
      writes.push({ method: "put", id: String(row.id), fields: Object.keys(row).sort() });
      if (!txn.stage(String(row.id), { ...row })) store.set(String(row.id), { ...row });
      return row;
    },
    async update(id: string, patch: Record<string, any>) {
      writes.push({ method: "update", id, fields: Object.keys(patch).sort() });
      const merged = { ...(store.get(id) ?? { id }), ...patch };
      if (!txn.stage(id, merged)) store.set(id, merged);
      return merged;
    },
  };
}

beforeEach(() => {
  store = new Map();
  writes = [];
  txn = installFakeHarperTransaction((id, row) => store.set(id, row));
});
afterEach(() => {
  txn.restore();
});

describe("patchRecord — the lastReflected stamp is a field-only update (flair#2494)", () => {
  test("writes exactly one incremental update naming only the patch's fields, never a full-row put", async () => {
    store.set("m1", { id: "m1", agentId: "agent-a", content: "x", instanceToken: "t", contentHash: "h", createdAt: "2026-01-01T00:00:00.000Z" });
    await patchRecord(recordingTable(), "m1", { lastReflected: "2026-10-12T00:00:00.000Z" });
    expect(writes).toEqual([{ method: "update", id: "m1", fields: ["lastReflected"] }]);
    expect(store.get("m1")?.lastReflected).toBe("2026-10-12T00:00:00.000Z");
  });
});
