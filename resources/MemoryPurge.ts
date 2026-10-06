/**
 * MemoryPurge.ts — operator-triggered PHYSICAL removal of Memory rows.
 *
 * POST /MemoryPurge { ids: string[] } removes the named Memory rows from the
 * store. A skill-tagged row (or any row carrying a `skillSubjectId`) expands to
 * every row in its skill lineage, so a superseded version row is removed
 * together with its live head. Each durable row's removal is recorded through
 * recordMemoryDeletion in the same owned transaction, the way Memory.delete()'s
 * physical branch records it; a failed pointer delete or history write aborts
 * the call's transaction, so nothing it removed commits.
 *
 * This is a separate path from the user-facing `DELETE /Memory/<id>` route.
 * A skill-tagged row deleted through the REST route is versioned — its head is
 * closed, not removed — and that route's semantics are unchanged. This path is
 * admin-only (allowAdmin), the authority the operator commands that call it
 * hold today.
 *
 * A row counts as removed only when its delete is confirmed — Harper's table
 * delete reports success only for a row it removed — and its durable-deletion
 * record commits in the same transaction; a failed pointer delete or history
 * write aborts the call's transaction, so nothing it removed commits.
 */
import { Resource, databases } from "harper";
import { allowAdmin } from "./agent-auth.js";
import { recordMemoryDeletion } from "./memory-deletion-history.js";
import { withOwnedTransaction } from "./request-transaction.js";
import { MEMORY_HOST_SOURCE_TABLE } from "./memory-host-source.js";

/** Delete the pointer row for a removed Memory row, in the given transaction,
 *  through the pointer-table ADAPTER. A missing table THROWS (fail closed). */
async function deletePointerRowOrThrow(memoryId: string, ctx: any): Promise<void> {
  const table = (databases as any).flair?.[MEMORY_HOST_SOURCE_TABLE];
  if (!table?.delete) {
    throw new Error("MemoryHostSource table unavailable");
  }
  await table.delete(memoryId, ctx);
}

export class MemoryPurge extends Resource {
  /** Admin only: the same authority the calling operator commands hold. */
  async allowCreate(): Promise<boolean> {
    return allowAdmin((this as any).getContext?.());
  }

  async post(data: any) {
    const ids: string[] = Array.isArray(data?.ids)
      ? data.ids.filter((x: unknown): x is string => typeof x === "string" && x.length > 0)
      : [];
    if (ids.length === 0) {
      return new Response(JSON.stringify({ error: "ids required" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    const ctx = (this as any).getContext?.();
    const memory = (databases as any).flair?.Memory;
    if (!memory || typeof memory.get !== "function" || typeof memory.search !== "function" || typeof memory.delete !== "function") {
      return new Response(JSON.stringify({ error: "Memory table unavailable" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }

    // Resolve the full target set before mutating: every named row plus, for a
    // skill row, every row in its skill lineage (superseded version rows
    // included). A read that fails propagates — it never reads as "absent".
    const targets = new Map<string, Record<string, any>>();
    for (const id of ids) {
      const row = await memory.get(id);
      if (!row) continue;
      const rowId = String(row.id ?? id);
      targets.set(rowId, row);
      const subjectId = typeof row.skillSubjectId === "string" && row.skillSubjectId.length > 0
        ? row.skillSubjectId
        : Array.isArray(row.tags) && row.tags.includes("skill") ? rowId : null;
      if (!subjectId) continue;
      for await (const sibling of memory.search({
        conditions: [{ attribute: "skillSubjectId", comparator: "equals", value: subjectId }],
      })) {
        if (sibling && typeof sibling.id === "string" && sibling.id.length > 0) targets.set(sibling.id, sibling);
      }
    }

    // ONE owned transaction per call: each row's delete, its pointer delete and
    // its durable-deletion record commit together or not at all. `removed`
    // counts only rows whose delete was confirmed; a delete that reports
    // anything but success throws and aborts the whole call.
    let removed = 0;
    await withOwnedTransaction(ctx, async (c) => {
      for (const id of targets.keys()) {
        const stored = await memory.get(id, c);
        if (!stored) continue;
        const result = await memory.delete(id, c);
        if (result !== true) throw new Error(`Memory row delete was not confirmed (${id})`);
        await deletePointerRowOrThrow(id, c);
        await recordMemoryDeletion({
          memoryId: id,
          memoryInstanceToken: stored.instanceToken ?? null,
          durability: stored.durability ?? null,
          actor: null,
          sourceClass: "admin",
        }, c);
        removed++;
      }
    });

    return { removed };
  }
}
