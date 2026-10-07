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
 * Harper queues a delete and can skip it at commit, so every delete below is
 * checked by a read after its commit, and the steps run in this order:
 *
 *  1. One owned transaction holds each target's row delete and, for a
 *     permanent or persistent row, its deletion-history record (other rows get
 *     none); a failed history write aborts it. A target that is not stored when
 *     the call reads it before deleting fails the call before anything commits
 *     (404 memory_purge_target_missing).
 *  2. A read after the commit sorts the targets: `removedIds` lists the ones it
 *     finds gone; the others are still stored.
 *  3. For a target still stored, the call deletes the deletion-history record
 *     step 1 wrote for it and reads again after that commit.
 *  4. Host-pointer rows are deleted only for targets step 2 found gone, so a
 *     row that is still stored keeps its pointer row. One owned transaction
 *     re-reads each such row and deletes its pointer row through the
 *     pointer-table adapter while the row is still absent; a read after that
 *     commit looks for pointer rows left for rows that are still absent.
 *
 * Reply, checked in this order: a failed history delete, or a deletion-history
 * record still stored after step 3, fails the call (500
 * memory_purge_history_cleanup_unconfirmed, with the record ids); a failed
 * pointer delete, or a pointer row left after step 4, fails it (500
 * memory_purge_pointer_cleanup_failed): those rows are removed, and the
 * maintenance orphan sweep deletes such pointer rows; a target still stored
 * fails it (409 memory_purge_unconfirmed). Otherwise the reply is
 * `{ removed, removedIds }`.
 *
 * This is a separate path from the user-facing `DELETE /Memory/<id>` route.
 * A skill-tagged row deleted through the REST route is versioned — its head is
 * closed, not removed — and that route's semantics are unchanged.
 */
import { Resource, databases } from "harper";
import { resolveAgentAuth } from "./agent-auth.js";
import { soulWriteSource } from "./soul-write-policy.js";
import { recordMemoryDeletion, removeMemoryDeletionRecords } from "./memory-deletion-history.js";
import { withOwnedTransaction } from "./request-transaction.js";
import { deletePointerRowViaTable } from "./host-pointer-adapter.js";
import { storedPointerIds } from "./memory-host-source.js";

function reply(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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

    // 1. ONE owned transaction per call: a failed read or history write aborts
    // every write in it. No pointer row is touched here (step 4).
    const historyIds = new Map<string, string>();
    try {
      await withOwnedTransaction(ctx, async (c) => {
        for (const id of targets.keys()) {
          const stored = await memory.get(id, c);
          if (!stored) throw new MissingTarget([id]);
          await memory.delete(id, c);
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

    // 2. Confirm against the committed store: a target counts as removed only
    // if a read after the commit finds it gone.
    const removedIds: string[] = [];
    const stillStored: string[] = [];
    await withOwnedTransaction(ctx, async (c) => {
      for (const id of targets.keys()) {
        if (await memory.get(id, c)) stillStored.push(id);
        else removedIds.push(id);
      }
    });

    // 3. A row still stored keeps no deletion-history record from this call;
    // the removal is checked by a read after its commit. A failed cleanup
    // leaves every one of these records unconfirmed.
    const staleHistory = stillStored.flatMap((id) => {
      const historyId = historyIds.get(id);
      return historyId ? [{ memoryId: id, historyId }] : [];
    });
    let historyError: unknown = null;
    let historyLeft: Set<string>;
    try {
      historyLeft = new Set(await removeMemoryDeletionRecords(staleHistory.map((h) => h.historyId), ctx));
    } catch (err) {
      historyError = err;
      historyLeft = new Set(staleHistory.map((h) => h.historyId));
    }

    // 4. Pointer rows of the rows step 2 found gone. A row stored again under
    // the same id before this transaction keeps its pointer row.
    let pointerError: unknown = null;
    if (removedIds.length > 0) {
      try {
        await withOwnedTransaction(ctx, async (c) => {
          for (const id of removedIds) {
            if (!(await memory.get(id, c))) await deletePointerRowViaTable(id, c);
          }
        });
      } catch (err) {
        pointerError = err;
      }
    }
    const pointerLeft: string[] = [];
    const pointers = await storedPointerIds(removedIds);
    if (pointers.size > 0) {
      await withOwnedTransaction(ctx, async (c) => {
        for (const id of removedIds) {
          if (pointers.has(id) && !(await memory.get(id, c))) pointerLeft.push(id);
        }
      });
    }

    if (historyLeft.size > 0) {
      const left = staleHistory.filter((h) => historyLeft.has(h.historyId));
      return reply(500, {
        error: "memory_purge_history_cleanup_unconfirmed",
        message: `these rows are still stored after the commit, and the deletion-history records written for them ${historyError !== null
          ? `could not be deleted (${errorText(historyError)})`
          : "are still stored after their delete"}`,
        ids: left.map((h) => h.memoryId),
        historyIds: left.map((h) => h.historyId),
        stillStoredIds: stillStored,
        removedIds,
      });
    }
    if (pointerError !== null || pointerLeft.length > 0) {
      return reply(500, {
        error: "memory_purge_pointer_cleanup_failed",
        message: `${pointerError !== null
          ? `the pointer-row delete for the removed rows failed (${errorText(pointerError)})`
          : "these removed rows still have a pointer row after its delete"}; the rows are removed, and the maintenance orphan sweep deletes a pointer row whose Memory row is gone`,
        ids: pointerLeft,
        stillStoredIds: stillStored,
        removedIds,
      });
    }
    if (stillStored.length > 0) {
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
