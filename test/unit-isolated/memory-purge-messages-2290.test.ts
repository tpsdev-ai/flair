import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { databasesMock, harnessState, installMemoryHarperMock, resetHarnessState } from "../helpers/memory-search-harness";

process.env.FLAIR_RATE_LIMIT_ENABLED = "false";
await installMemoryHarperMock();
const { MemoryPurge } = await import("../../resources/MemoryPurge.ts");
const historyTable = {
  put: databasesMock.flair.MemoryDeletionHistory.put,
  async get(id: string) { return harnessState.deletionStore.get(id) ?? null; },
  async delete(id: string, ctx: any) {
    ctx.transaction.staged.push(() => harnessState.deletionStore.delete(id));
  },
};
(databasesMock.flair as any).MemoryDeletionHistory = historyTable;

const spies: Array<{ mockRestore(): void }> = [];
beforeEach(resetHarnessState);
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

function seed(id: string) {
  harnessState.memoryStore.set(id, { id, agentId: "owner", durability: "permanent" });
  harnessState.pointerStore.set(id, { memoryId: id });
}

async function purge(ids: string[]) {
  const resource: any = new MemoryPurge();
  resource.getContext = () => ({});
  const response = await resource.post({ ids });
  expect(response).toBeInstanceOf(Response);
  return { status: response.status, body: await response.json() };
}

function keepMemory(id: string) {
  const originalDelete = databasesMock.flair.Memory.delete;
  spies.push(spyOn(databasesMock.flair.Memory, "delete").mockImplementation(async (target, ctx) => {
    if (target === id) return true;
    return originalDelete(target, ctx);
  }));
}

test("history still stored returns the named 500 before the still-stored 409", async () => {
  seed("stored");
  keepMemory("stored");
  spies.push(spyOn(historyTable, "delete").mockResolvedValue(undefined));
  const { status, body } = await purge(["stored"]);
  expect(status).toBe(500);
  expect(body).toMatchObject({
    error: "memory_purge_history_cleanup_unconfirmed",
    message: "these rows are still stored after the commit; their deletion-history records were not deleted and are still stored",
    stillStoredIds: ["stored"], removedIds: [],
  });
  expect(body.historyIds).toEqual([...harnessState.deletionStore.keys()]);
  expect(harnessState.pointerStore.has("stored")).toBe(true);
});

test("failed history delete reports deletion not confirmed", async () => {
  seed("stored");
  keepMemory("stored");
  spies.push(spyOn(historyTable, "delete").mockRejectedValue(new Error("history delete failed")));
  const { status, body } = await purge(["stored"]);
  expect(status).toBe(500);
  expect(body.error).toBe("memory_purge_history_cleanup_unconfirmed");
  expect(body.message).toBe("these rows are still stored after the commit; could not confirm deletion of their deletion-history records (history delete failed)");
  expect(harnessState.deletionStore.size).toBe(1);
});

test("failed history confirmation read reports deletion not confirmed after deletion commits", async () => {
  seed("stored");
  keepMemory("stored");
  spies.push(spyOn(historyTable, "get").mockRejectedValue(new Error("history read failed")));
  const { status, body } = await purge(["stored"]);
  expect(status).toBe(500);
  expect(body.error).toBe("memory_purge_history_cleanup_unconfirmed");
  expect(body.message).toBe("these rows are still stored after the commit; could not confirm deletion of their deletion-history records (history read failed)");
  expect(body.historyIds).toHaveLength(1);
  expect(harnessState.deletionStore.size).toBe(0);
  expect(harnessState.memoryStore.has("stored")).toBe(true);
});

for (const failure of ["throw", "skip"] as const) {
  test(`mixed batch with ${failure} pointer cleanup names removedIds in the message`, async () => {
    seed("stored");
    seed("removed");
    keepMemory("stored");
    const pointerDelete = spyOn(databasesMock.flair.MemoryHostSource, "delete");
    spies.push(pointerDelete);
    if (failure === "throw") pointerDelete.mockRejectedValue(new Error("pointer delete failed"));
    else pointerDelete.mockResolvedValue({ ok: true });
    const { status, body } = await purge(["stored", "removed"]);
    expect(status).toBe(500);
    expect(body).toMatchObject({
      error: "memory_purge_pointer_cleanup_failed",
      stillStoredIds: ["stored"], removedIds: ["removed"],
      message: failure === "throw"
        ? "the pointer-row delete for rows in removedIds failed (pointer delete failed)"
        : "rows in removedIds still have a pointer row after its delete",
    });
    expect(body.ids).toEqual(["removed"]);
    expect(harnessState.memoryStore.has("stored")).toBe(true);
    expect(harnessState.memoryStore.has("removed")).toBe(false);
    expect(harnessState.pointerStore.has("stored")).toBe(true);
    expect(harnessState.pointerStore.has("removed")).toBe(true);
    expect([...harnessState.deletionStore.values()].map((row) => row.memoryId)).toEqual(["removed"]);
  });
}
