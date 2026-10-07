/**
 * The watcher reads this table through the operations API.
 * No resource class or @export: there is no direct route.
 */
import { randomUUID } from "node:crypto";
import { databases } from "harper";

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

/** Delete one deletion-history record by its id. */
export async function removeMemoryDeletionRecord(id: string, ctx?: unknown): Promise<void> {
  const table = (databases as any).flair?.[MEMORY_DELETION_HISTORY_TABLE];
  if (!table?.delete) {
    throw new Error(`${MEMORY_DELETION_HISTORY_TABLE} table unavailable`);
  }
  await table.delete(id, ctx as any);
}
