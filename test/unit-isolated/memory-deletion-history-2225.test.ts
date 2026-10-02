import { beforeEach, expect, test, spyOn } from "bun:test";
import { harnessState, resetHarnessState, installMemoryHarperMock, databasesMock } from "../helpers/memory-search-harness";
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
