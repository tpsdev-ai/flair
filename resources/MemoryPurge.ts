/**
 * MemoryPurge.ts — operator-triggered PHYSICAL removal of Memory rows.
 *
 * POST /MemoryPurge { ids: string[] } removes the named Memory rows from the
 * store. A skill-tagged row (or any row carrying a `skillSubjectId`) expands to
 * every row in its skill lineage, so a superseded version row is removed
 * together with its live head.
 *
 * Authority: the operator source (`soulWriteSource`): verified Basic
 * administrator credentials, or a deliberate internal call. Agent keys, admin
 * agent keys included, are refused.
 *
 * One owned transaction holds each target's row delete, its pointer-row delete
 * (through the pointer-table adapter) and its deletion-history record; a failed
 * pointer delete or history write aborts it, so none of them commits. Harper
 * queues a delete and can skip it at commit, so after the commit the call reads
 * each target again. A target still stored fails the call: the history record
 * written for it is deleted, then the call replies 409 memory_purge_unconfirmed
 * (if that history delete fails, the call fails with its error instead). A
 * target that is not stored when the call reads it before deleting fails the
 * call before anything commits (404 memory_purge_target_missing). `removedIds`
 * lists the targets the post-commit read found gone.
 *
 * This is a separate path from the user-facing `DELETE /Memory/<id>` route.
 * A skill-tagged row deleted through the REST route is versioned — its head is
 * closed, not removed — and that route's semantics are unchanged.
 */
import { Resource, databases } from "harper";
import { resolveAgentAuth } from "./agent-auth.js";
import { soulWriteSource } from "./soul-write-policy.js";
import { recordMemoryDeletion, removeMemoryDeletionRecord } from "./memory-deletion-history.js";
import { withOwnedTransaction } from "./request-transaction.js";
import { deletePointerRowViaTable } from "./host-pointer-adapter.js";

function reply(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A target that is not stored when the call reads it before deleting. */
class MissingTarget extends Error {
  constructor(readonly ids: string[]) {
    super("memory_purge_target_missing");
  }
}

export class MemoryPurge extends Resource {
  /** The operator source only (`soulWriteSource`). */
  async allowCreate(): Promise<boolean> {
    const context = (this as any).getContext?.();
    return soulWriteSource(context, await resolveAgentAuth(context)) !== null;
  }

  async post(data: any) {
    const ids: unknown = data?.ids;
    if (!Array.isArray(ids) || ids.length === 0 || !ids.every((x) => typeof x === "string" && x.length > 0)) {
      return reply(400, { error: "memory_purge_ids_invalid", message: "ids must be a non-empty array of non-empty strings" });
    }
    const ctx = (this as any).getContext?.();
    const memory = (databases as any).flair?.Memory;
    if (!memory || typeof memory.get !== "function" || typeof memory.search !== "function" || typeof memory.delete !== "function") {
      return reply(500, { error: "Memory table unavailable" });
    }

    // Resolve the full target set before mutating: every named row plus, for a
    // skill row, every row in its skill lineage (superseded version rows
    // included). A read that fails propagates — it never reads as "absent".
    const targets = new Map<string, Record<string, any>>();
    const missing: string[] = [];
    for (const id of new Set(ids as string[])) {
      const row = await memory.get(id);
      if (!row) {
        missing.push(id);
        continue;
      }
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
    if (missing.length > 0) {
      return reply(404, { error: "memory_purge_target_missing", ids: missing });
    }

    // ONE owned transaction per call: a failed read, pointer delete or history
    // write aborts every write in it.
    const historyIds = new Map<string, string>();
    try {
      await withOwnedTransaction(ctx, async (c) => {
        for (const id of targets.keys()) {
          const stored = await memory.get(id, c);
          if (!stored) throw new MissingTarget([id]);
          await memory.delete(id, c);
          await deletePointerRowViaTable(id, c);
          const historyId = await recordMemoryDeletion({
            memoryId: id,
            memoryInstanceToken: stored.instanceToken ?? null,
            durability: stored.durability ?? null,
            actor: null,
            sourceClass: "admin",
          }, c);
          if (historyId) historyIds.set(id, historyId);
        }
      });
    } catch (err) {
      if (err instanceof MissingTarget) return reply(404, { error: "memory_purge_target_missing", ids: err.ids });
      throw err;
    }

    // Confirm against the committed store: a target counts as removed only if
    // a read after the commit finds it gone.
    const removedIds: string[] = [];
    const stillStored: string[] = [];
    await withOwnedTransaction(ctx, async (c) => {
      for (const id of targets.keys()) {
        if (await memory.get(id, c)) stillStored.push(id);
        else removedIds.push(id);
      }
    });
    if (stillStored.length > 0) {
      await withOwnedTransaction(ctx, async (c) => {
        for (const id of stillStored) {
          const historyId = historyIds.get(id);
          if (historyId) await removeMemoryDeletionRecord(historyId, c);
        }
      });
      return reply(409, {
        error: "memory_purge_unconfirmed",
        message: "these rows are still stored after the commit; retry the purge",
        ids: stillStored,
        removedIds,
      });
    }
    return { removed: removedIds.length, removedIds };
  }
}
