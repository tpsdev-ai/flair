/**
 * memory-deletion-history.ts — the durable, attributable record of a Memory
 * row removed through a Flair path (flair#2213).
 *
 * The out-of-store integrity watcher (`flair integrity check`) can only tell a
 * deliberate delete from a silent, below-Flair loss if the deliberate one left
 * a record it can read. Everything that removes a Memory row through Flair —
 * `Memory.delete()` (REST/MCP) and `MemoryMaintenance`'s ephemeral-expiry sweep
 * — appends one `MemoryDeletionHistory` row in the SAME transaction as the
 * delete, so the record and the row die or survive together. A row removed
 * beneath Flair (a raw table delete by a storage-level rebuild, a rollback, or
 * the ops API) leaves no row here, so its disappearance stays UNATTRIBUTED.
 *
 * Append-only. No resource class and no `@export`: the watcher reads it
 * in-process, there is no direct route (the same shape as
 * OrgSkillAssignmentHistory).
 */
import { randomUUID } from "node:crypto";
import { databases } from "harper";

export const MEMORY_DELETION_HISTORY_TABLE = "MemoryDeletionHistory";

export type MemoryDeletionSourceClass = "agent" | "admin" | "internal";

export interface MemoryDeletionInput {
  memoryId: string;
  /** The deleted row's durability at deletion, when known. */
  durability?: string | null;
  /** The deleting principal; null for an internal/maintenance delete. */
  actor?: string | null;
  sourceClass: MemoryDeletionSourceClass;
  at?: string;
}

/**
 * Append one deletion record, joining the caller's transaction when `ctx`
 * carries one (so it commits with the Memory row delete it describes).
 */
export async function recordMemoryDeletion(input: MemoryDeletionInput, ctx?: unknown): Promise<void> {
  const table = (databases as any).flair?.[MEMORY_DELETION_HISTORY_TABLE];
  if (!table?.put) {
    throw new Error(`${MEMORY_DELETION_HISTORY_TABLE} table unavailable`);
  }
  await table.put(
    {
      id: randomUUID(),
      memoryId: input.memoryId,
      durability: input.durability ?? null,
      actor: input.actor ?? null,
      sourceClass: input.sourceClass,
      at: input.at ?? new Date().toISOString(),
    },
    ctx as any,
  );
}
