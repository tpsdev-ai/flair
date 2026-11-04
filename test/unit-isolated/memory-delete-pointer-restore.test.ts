import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import { harnessState, resetHarnessState, installMemoryHarperMock, databasesMock } from "../helpers/memory-search-harness";

const transactionModule = new URL("../../node_modules/harper/dist/resources/DatabaseTransaction.js", import.meta.url).href;
const { DatabaseTransaction } = await import(transactionModule);
const { Memory } = await installMemoryHarperMock();
const { restorePointerRowIfAbsent, PointerAlreadyStoredError } = await import("../../resources/host-pointer-adapter.ts");
const { withOwnedTransaction } = await import("../../resources/request-transaction.ts");
const pointer = {
  memoryId: "pointer-restore", hostSource: JSON.stringify({ v: 1, host: "host-a", kind: "run", id: "run-a" }),
  scopeAtWrite: null, authorId: "agent-a", memoryInstanceToken: "old-token", receivedAt: "2026-01-01T00:00:00.000Z",
};

beforeEach(resetHarnessState);

describe("ordinary DELETE pointer compensation commit guard", () => {
  it("restores an absent pointer through the table", async () => {
    await withOwnedTransaction({}, async (ctx) => {
      await restorePointerRowIfAbsent(pointer, ctx);
      expect(harnessState.pointerStore.has(pointer.memoryId)).toBe(false);
    });
    expect(harnessState.pointerStore.get(pointer.memoryId)).toEqual(pointer);
  });

  it("refuses a replacement committed after staging and before the restore commits", async () => {
    const replacement = { ...pointer, memoryInstanceToken: "replacement-token", authorId: "replacement-author" };
    const error = await withOwnedTransaction({}, async (ctx) => {
      await restorePointerRowIfAbsent(pointer, ctx);
      harnessState.pointerStore.set(pointer.memoryId, replacement);
    }).then(() => null, (err) => err);
    expect(harnessState.pointerStore.get(pointer.memoryId)).toEqual(replacement);
    expect(error).toBeInstanceOf(PointerAlreadyStoredError);
  });

  it("Harper save retains read absence until a conflict retry", async () => {
    let guard: any;
    await withOwnedTransaction({}, async (ctx) => {
      const addWrite = ctx.transaction.addWrite.bind(ctx.transaction);
      ctx.transaction.addWrite = (write: any) => { guard = write; return addWrite(write); };
      await restorePointerRowIfAbsent(pointer, ctx);
    });
    expect(guard).toBeDefined();
    guard.saved = true;
    const txn = { open: 1, timestamp: 1, retries: 0 };
    const save = DatabaseTransaction.prototype.save as any;
    const reads = spyOn(guard.store, "getEntry");
    try {
      save.call(txn, guard, {}, false);
      expect(reads).not.toHaveBeenCalled();
      const replacement = { ...pointer, memoryInstanceToken: "replacement-token" };
      harnessState.pointerStore.set(pointer.memoryId, replacement);
      txn.retries = 1;
      expect(() => save.call(txn, guard, {}, true)).toThrow(PointerAlreadyStoredError);
      expect(harnessState.pointerStore.get(pointer.memoryId)).toEqual(replacement);
    } finally {
      reads.mockRestore();
    }
  });

  it("answers 500 when the restored pointer has a different author", async () => {
    const row = {
      id: pointer.memoryId, agentId: pointer.authorId, content: "pointer restoration", createdAt: pointer.receivedAt,
      instanceToken: pointer.memoryInstanceToken,
    };
    harnessState.memoryStore.set(row.id, row);
    harnessState.pointerStore.set(row.id, pointer);
    const originalPut = databasesMock.flair.MemoryHostSource.put;
    const corruptRestore = spyOn(databasesMock.flair.MemoryHostSource, "put").mockImplementation((value: any, ctx?: any) =>
      originalPut({ ...value, authorId: "unexpected-author" }, ctx));
    const droppedRemoval = spyOn(databasesMock.flair.Memory, "delete").mockResolvedValue(true);
    try {
      const resource: any = new (Memory as any)();
      resource.getContext = () => ({ request: { tpsAgent: pointer.authorId } });
      const response = await resource.delete(row.id);
      expect(response.status).toBe(500);
      expect((await response.json()).error).toBe("delete_compensation_failed");
      expect(harnessState.memoryStore.get(row.id)).toEqual(row);
      expect(harnessState.deletionStore.size).toBe(0);
    } finally {
      droppedRemoval.mockRestore();
      corruptRestore.mockRestore();
    }
  });
});
