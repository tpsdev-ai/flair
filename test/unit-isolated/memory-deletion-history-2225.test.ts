import { beforeEach, expect, test, spyOn } from "bun:test";
import { harnessState, resetHarnessState, installMemoryHarperMock, databasesMock, mockTransaction } from "../helpers/memory-search-harness";
import { compareScan, emptyCheckpoint } from "../../src/lib/memory-integrity";
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

test("an ordinary legacy PUT assigns its first token without a replaced loss", async () => {
  const row = { id: "m", agentId: "owner", durability: "permanent", content: "A legacy memory with enough content for an ordinary update.", visibility: "shared", instanceToken: null };
  harnessState.memoryStore.set(row.id, row);
  const checkpoint = emptyCheckpoint("before", [row]);
  expect(checkpoint.instanceTokens.m).toBeNull();
  await resource().put({ ...row, content: "Updated legacy memory content with enough text for the gate." });
  const updated = harnessState.memoryStore.get(row.id);
  expect(updated.content).toBe("Updated legacy memory content with enough text for the gate.");
  expect(typeof updated.instanceToken).toBe("string");
  expect(updated.instanceToken.length).toBeGreaterThan(0);
  const verdict = compareScan({ checkpoint, rows: [updated], deletions: [], scannedAt: "after" });
  expect(verdict.status).toBe("healthy");
  expect(verdict.losses).toEqual([]);
  expect(emptyCheckpoint("after", [updated]).instanceTokens.m).toBe(updated.instanceToken);
  expect(harnessState.deletionStore.size).toBe(0);
});

for (const durability of ["permanent", "persistent"] as const) {
  test(`${durability} Memory.delete rolls back Memory and successful history on a late abort`, async () => {
    const row = { id: "m", agentId: "owner", durability, instanceToken: "2026-10-01", expiresAt: "2000-01-01" };
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
      await expect(resource().delete(row.id)).rejects.toThrow("late abort after history");
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

  test(`${durability} Memory.delete records the stored incarnation on a committed delete`, async () => {
    harnessState.memoryStore.set("m", { id: "m", agentId: "owner", durability, instanceToken: "2026-10-01", expiresAt: "2000-01-01" });
    await resource().delete("m");
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

for (const durability of ["standard", "ephemeral", null, "unexpected"]) {
  test(`${durability} deletes do not require or grow history`, async () => {
    harnessState.memoryStore.set("m", { id: "m", agentId: "owner", durability });
    const history = spyOn(databasesMock.flair.MemoryDeletionHistory, "put").mockRejectedValue(new Error("history down"));
    try {
      await resource().delete("m");
      expect(harnessState.memoryStore.has("m")).toBe(false);
      expect(history).not.toHaveBeenCalled();
      expect(harnessState.deletionStore.size).toBe(0);
    } finally { history.mockRestore(); }
  });
}

test("repeated ephemeral expiry batches leave no deletion history", async () => {
  const r: any = new (MemoryMaintenance as any)();
  r.getContext = () => ({ request: { tpsAgent: "admin", tpsAgentIsAdmin: true } });
  const history = spyOn(databasesMock.flair.MemoryDeletionHistory, "put").mockRejectedValue(new Error("history down"));
  try {
    for (let batch = 0; batch < 4; batch++) {
      for (let i = 0; i < 100; i++) {
        const id = `expired-${batch}-${i}`;
        harnessState.memoryStore.set(id, { id, agentId: "owner", durability: "ephemeral", instanceToken: id, expiresAt: "2000-01-01" });
      }
      expect((await r.post({})).expired).toBe(100);
      expect(harnessState.memoryStore.size).toBe(0);
      expect(harnessState.deletionStore.size).toBe(0);
    }
    expect(history).not.toHaveBeenCalled();
  } finally { history.mockRestore(); }
});
