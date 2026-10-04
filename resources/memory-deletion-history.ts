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

export async function recordMemoryDeletion(input: MemoryDeletionInput, ctx?: unknown): Promise<void> {
  if (input.durability !== "permanent" && input.durability !== "persistent") return;
  const table = (databases as any).flair?.[MEMORY_DELETION_HISTORY_TABLE];
  if (!table?.put) {
    throw new Error(`${MEMORY_DELETION_HISTORY_TABLE} table unavailable`);
  }
  await table.put(
    {
      id: randomUUID(),
      memoryId: input.memoryId,
      memoryInstanceToken: input.memoryInstanceToken ?? null,
      durability: input.durability ?? null,
      actor: input.actor ?? null,
      sourceClass: input.sourceClass,
      at: input.at ?? new Date().toISOString(),
    },
    ctx as any,
  );
}
