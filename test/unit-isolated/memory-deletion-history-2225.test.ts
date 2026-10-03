import { beforeEach, expect, test, spyOn } from "bun:test";
import { harnessState, resetHarnessState, installMemoryHarperMock, databasesMock, mockTransaction } from "../helpers/memory-search-harness";
process.env.FLAIR_RATE_LIMIT_ENABLED = "false";
delete process.env.FLAIR_PUBLIC;
installMemoryHarperMock();
const { Memory } = await import("../../resources/Memory.ts");
const { MemoryMaintenance } = await import("../../resources/MemoryMaintenance.ts");
const resource = () => {
  const r: any = new (Memory as any)();
  r.getContext = () => ({ request: { tpsAgent: "owner" } });
  return r;
};
beforeEach(resetHarnessState);

for (const writer of ["Memory.delete", "MemoryMaintenance"] as const) {
  test(`${writer} rolls back Memory and successful history on a late abort`, async () => {
    const row = { id: "m", agentId: "owner", durability: writer === "Memory.delete" ? "permanent" : "ephemeral", instanceToken: "2026-10-01", expiresAt: "2000-01-01" };
    harnessState.memoryStore.set(row.id, row);
    const originalTransaction = (globalThis as any).transaction;
    const originalPut = databasesMock.flair.MemoryDeletionHistory.put;
    let historySucceeded = false;
    let historyTransaction: any;
    let wasOpen = false;
    const deleted = spyOn(databasesMock.flair.Memory, "delete");
    const history = spyOn(databasesMock.flair.MemoryDeletionHistory, "put").mockImplementation(async (entry, ctx) => {
      const result = await originalPut(entry, ctx);
      historySucceeded = true;
      historyTransaction = (ctx as any)?.transaction;
      wasOpen = historyTransaction?.open === 1;
      return result;
    });
    (globalThis as any).transaction = (ctx: any, cb: (txn: any) => any) => mockTransaction(ctx, async (txn) => {
      const result = await cb(txn);
      if (historySucceeded) throw new Error("late abort after history");
      return result;
    });
    try {
      if (writer === "Memory.delete") {
        await expect(resource().delete(row.id)).rejects.toThrow("late abort after history");
      } else {
        const r: any = new (MemoryMaintenance as any)();
        r.getContext = () => ({ request: { tpsAgent: "admin", tpsAgentIsAdmin: true } });
        const response = await r.post({});
        expect(response.status).toBe(500);
        expect((await response.json()).stats.expired).toBe(0);
      }
      expect(historySucceeded).toBe(true);
      expect(harnessState.memoryStore.get(row.id)).toEqual(row);
      expect(harnessState.deletionStore.size).toBe(0);
      expect(history).toHaveBeenCalledTimes(1);
      expect(history.mock.calls[0][0].memoryInstanceToken).toBe(row.instanceToken);
      expect(history.mock.calls[0][1]).toBe(deleted.mock.calls[0][1]);
      expect(wasOpen).toBe(true);
      expect(historyTransaction.aborted).toBe(true);
    } finally {
      history.mockRestore();
      deleted.mockRestore();
      (globalThis as any).transaction = originalTransaction;
    }
  });

  test(`${writer} records the stored incarnation on a committed delete`, async () => {
    harnessState.memoryStore.set("m", { id: "m", agentId: "owner", durability: writer === "Memory.delete" ? "permanent" : "ephemeral", instanceToken: "2026-10-01", expiresAt: "2000-01-01" });
    if (writer === "Memory.delete") await resource().delete("m");
    else {
      const r: any = new (MemoryMaintenance as any)();
      r.getContext = () => ({ request: { tpsAgent: "admin", tpsAgentIsAdmin: true } });
      expect((await r.post({})).expired).toBe(1);
    }
    expect(harnessState.memoryStore.has("m")).toBe(false);
    expect(harnessState.deletionStore.size).toBe(1);
    expect([...harnessState.deletionStore.values()][0].memoryInstanceToken).toBe("2026-10-01");
  });
}

test("a no-op Memory delete appends no history", async () => {
  await resource().delete("absent");
  expect(harnessState.deletionStore.size).toBe(0);
});

test("unconfirmed deletes append nothing and a failed history write aborts the delete", async () => {
  harnessState.memoryStore.set("m", { id: "m", agentId: "owner", durability: "permanent" });
  const failedDelete = spyOn(databasesMock.flair.Memory, "delete").mockResolvedValue(false);
  try {
    await expect(resource().delete("m")).rejects.toThrow("not confirmed");
    expect(harnessState.deletionStore.size).toBe(0);
    expect(harnessState.memoryStore.has("m")).toBe(true);
  } finally { failedDelete.mockRestore(); }
  const failedHistory = spyOn(databasesMock.flair.MemoryDeletionHistory, "put").mockRejectedValue(new Error("history down"));
  try {
    await expect(resource().delete("m")).rejects.toThrow("history down");
    expect(harnessState.memoryStore.has("m")).toBe(true);
    expect(harnessState.deletionStore.size).toBe(0);
  } finally { failedHistory.mockRestore(); }
});

test("maintenance does not record a row removed between its scan and delete", async () => {
  harnessState.memoryStore.set("expired", { id: "expired", agentId: "owner", durability: "ephemeral", expiresAt: "2000-01-01" });
  const read = spyOn(databasesMock.flair.Memory, "get").mockImplementation(async () => {
    harnessState.memoryStore.delete("expired");
    return null;
  });
  try {
    const r: any = new (MemoryMaintenance as any)();
    r.getContext = () => ({ request: { tpsAgent: "admin", tpsAgentIsAdmin: true } });
    const result = await r.post({});
    expect(result.expired).toBe(0);
    expect(harnessState.deletionStore.size).toBe(0);
  } finally { read.mockRestore(); }
});
