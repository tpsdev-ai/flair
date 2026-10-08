/**
 * The watcher reads this table through the operations API.
 * No resource class or @export: there is no direct route.
 */
import { randomUUID } from "node:crypto";
import { databases } from "harper";
import { withOwnedTransaction } from "./request-transaction.js";

export const MEMORY_DELETION_HISTORY_TABLE = "MemoryDeletionHistory";

export type MemoryDeletionSourceClass = "agent" | "admin" | "internal";

export interface MemoryDeletionInput {
  memoryId: string;
  memoryInstanceToken?: string | null;
  /** The deleted row's durability at deletion, when known. */
  durability?: string | null;
  /** The deleting principal; null when no actor is supplied. */
  actor?: string | null;
  sourceClass: MemoryDeletionSourceClass;
  at?: string;
}

/** Returns the record's id, or null when the durability needs no record. */
export async function recordMemoryDeletion(input: MemoryDeletionInput, ctx?: unknown): Promise<string | null> {
  if (input.durability !== "permanent" && input.durability !== "persistent") return null;
  const table = (databases as any).flair?.[MEMORY_DELETION_HISTORY_TABLE];
  if (!table?.put) {
    throw new Error(`${MEMORY_DELETION_HISTORY_TABLE} table unavailable`);
  }
  const id = randomUUID();
  await table.put(
    {
      id,
      memoryId: input.memoryId,
      memoryInstanceToken: input.memoryInstanceToken ?? null,
      durability: input.durability ?? null,
      actor: input.actor ?? null,
      sourceClass: input.sourceClass,
      at: input.at ?? new Date().toISOString(),
    },
    ctx as any,
  );
  return id;
}

/**
 * Delete deletion-history records by id in one owned transaction, then read
 * each again after the commit: Harper queues a delete and can skip it at
 * commit, so the delete's own result is not proof. Returns the ids still stored
 * after the commit (empty when every record is gone). A failed delete or read
 * throws.
 */
export async function removeMemoryDeletionRecords(ids: readonly string[], ctx?: unknown): Promise<string[]> {
  if (ids.length === 0) return [];
  const table = (databases as any).flair?.[MEMORY_DELETION_HISTORY_TABLE];
  if (typeof table?.delete !== "function" || typeof table?.get !== "function") {
    throw new Error(`${MEMORY_DELETION_HISTORY_TABLE} table unavailable`);
  }
  await withOwnedTransaction(ctx, async (c) => {
    for (const id of ids) await table.delete(id, c);
  });
  const stillStored: string[] = [];
  await withOwnedTransaction(ctx, async (c) => {
    for (const id of ids) {
      if (await table.get(id, c)) stillStored.push(id);
    }
  });
  return stillStored;
}
