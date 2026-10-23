/**
 * MemoryPurge.ts — operator-triggered PHYSICAL removal of Memory rows.
 *
 * POST /MemoryPurge { ids: string[] } targets named Memory rows for physical
 * deletion. A skill-tagged row (or any row carrying a `skillSubjectId`) expands
 * to every row in its skill lineage, including superseded versions.
 *
 * Authority: the operator source (`soulWriteSource`): verified Basic
 * administrator credentials, or a deliberate internal call. Agent keys, admin
 * agent keys included, are refused.
 *
 * Harper queues a delete and can skip it at commit, so every delete below is
 * checked by a read after its commit, and the steps run in this order, all of
 * them while the call holds the per-id Memory write locks of its target set
 * (flair#2478 slice 3b):
 *
 *  1. One owned transaction holds each target's row delete and, for a
 *     permanent or persistent row, its deletion-history record (other rows get
 *     none); a failed history write aborts it. A target that is not stored when
 *     the call reads it before deleting fails the call before anything commits
 *     (404 memory_purge_target_missing).
 *  2. A read after the commit sorts the targets: `removedIds` lists the ones it
 *     finds gone; the others are still stored.
 *  3. For a target still stored, the call attempts deletion of the history
 *     record step 1 wrote for it and checks for absence after that commit.
 *  4. Host-pointer rows are deleted only for targets step 2 found gone, so a
 *     row that is still stored keeps its pointer row. One owned transaction
 *     re-reads each such row and deletes its pointer row through the
 *     pointer-table adapter while the row is still absent; a read after that
 *     commit looks for pointer rows left for rows that are still absent.
 *
 * The lock (flair#2478 slice 3b). The purge is an operator-initiated foreground
 * writer, so it takes the sorted, deduplicated `["memory", id]` keys of its
 * whole target set with the owner budget ({@link MEMORY_LOCK_ATTEMPTS}
 * attempts, {@link MEMORY_LOCK_WAIT_MS} apart) and holds them across every
 * commit above. A set that stayed held for the whole budget is refused `503
 * memory_busy` with the caller id and nothing else; an unresolved write on one
 * of the ids is refused `503 write_outcome_unknown`; a store with no lock is
 * refused `503 memory_lock_unavailable`. Nothing is written in those cases.
 * The set can only be named after a first read (a skill lineage is discovered
 * by search), so the call resolves it, takes its locks, and re-resolves it
 * under them: a set that changed in between is restarted, at most
 * {@link PURGE_SET_ATTEMPTS} attempts, then refused `409
 * memory_purge_targets_changed`. Inside the locks each target is re-read from
 * the committed store before it is deleted, so the deletion is decided on the
 * row the locks were taken for.
 *
 * Reply, checked in this order: unconfirmed history cleanup fails the call
 * (500 memory_purge_history_cleanup_unconfirmed, with the record ids); a failed
 * pointer delete or confirmation read, or a pointer row left after step 4,
 * fails it (500 memory_purge_pointer_cleanup_failed). A later successful maintenance sweep
 * can remove leftover pointers while their Memory rows remain absent. A target
 * still stored fails it (409 memory_purge_unconfirmed). Otherwise the reply is
 * `{ removed, removedIds }`.
 *
 * This is a separate path from the user-facing `DELETE /Memory/<id>` route.
 * An accepted DELETE of a non-reserved skill closes its head; the reserved
 * `using-flair` seed is physically deleted.
 */
import { Resource, databases } from "harper";
import { resolveAgentAuth } from "./agent-auth.js";
import { soulWriteSource } from "./soul-write-policy.js";
import { recordMemoryDeletion, removeMemoryDeletionRecords } from "./memory-deletion-history.js";
import { withOwnedTransaction } from "./request-transaction.js";
import { deletePointerRowViaTable } from "./host-pointer-adapter.js";
import { storedPointerIds } from "./memory-host-source.js";
import {
  memoryBusyResponse,
  memoryLockUnavailableResponse,
  withMemoryWriteLock,
  writeOutcomeUnknownResponse,
} from "./memory-write-lock.js";
import { txnPausePoint } from "./txn-pause-point.js";
import { withDetachedTxnAsync } from "./table-helpers.js";

/** Attempts at resolving a target set that keeps changing under the locks. */
const PURGE_SET_ATTEMPTS = 3;

function reply(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The caller id a lock-miss refusal carries — the request's agent annotation,
 *  else `internal`/`anonymous` (the rule the owner verbs use, Sherlock S7).
 *  Never stored-row state. */
function purgeCallerId(ctx: any): string {
  const request = ctx?.request ?? ctx;
  if (typeof request?.tpsAgent === "string" && request.tpsAgent.length > 0) return request.tpsAgent;
  if (request?.tpsAnonymous === true) return "anonymous";
  return "internal";
}

/** A target that is not stored when the call reads it before deleting. */
class MissingTarget extends Error {
  constructor(readonly ids: string[]) {
    super("memory_purge_target_missing");
  }
}

interface PurgeTargets {
  /** Stored rows by id: every named row plus its skill lineage. */
  rows: Map<string, Record<string, any>>;
  /** Named ids with no stored row. */
  missing: string[];
}

/**
 * Read the target set: every named row plus, for a skill row, every row in its
 * skill lineage (superseded version rows included). A read that fails
 * propagates — it never reads as "absent".
 */
async function resolvePurgeTargets(ctx: any, memory: any, ids: readonly string[]): Promise<PurgeTargets> {
  const rows = new Map<string, Record<string, any>>();
  const missing: string[] = [];
  for (const id of new Set(ids)) {
    // Detach from the request's transaction: a lineage row committed by
    // another request since this one started must be visible to the re-resolve
    // under the locks.
    const row = (await withDetachedTxnAsync(ctx, () => memory.get(id))) as Record<string, any> | null;
    if (!row) {
      missing.push(id);
      continue;
    }
    const rowId = String(row.id ?? id);
    rows.set(rowId, row);
    const subjectId = typeof row.skillSubjectId === "string" && row.skillSubjectId.length > 0
      ? row.skillSubjectId
      : Array.isArray(row.tags) && row.tags.includes("skill") ? rowId : null;
    if (!subjectId) continue;
    const siblings = await withDetachedTxnAsync(ctx, async () => {
      const found: Record<string, any>[] = [];
      for await (const sibling of memory.search({
        conditions: [{ attribute: "skillSubjectId", comparator: "equals", value: subjectId }],
      })) {
        found.push(sibling);
      }
      return found;
    });
    for (const sibling of siblings) {
      if (sibling && typeof sibling.id === "string" && sibling.id.length > 0) rows.set(sibling.id, sibling);
    }
  }
  return { rows, missing };
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
    let targets = await resolvePurgeTargets(ctx, memory, ids as string[]);
    if (targets.missing.length > 0) {
      return reply(404, { error: "memory_purge_target_missing", ids: targets.missing });
    }

    // flair#2478 slice 3b: the whole purge runs under the target set's per-id
    // Memory write locks, sorted, with the owner budget (a foreground operator
    // write). The set is re-resolved under the locks so a lineage member added
    // since the first read is locked too; a changed set restarts.
    for (let attempt = 1; attempt <= PURGE_SET_ATTEMPTS; attempt++) {
      // Test-only: one point per attempt, so a test can change the target set
      // between this attempt's resolve and its locked re-resolve.
      const resolvePause = attempt === 1
        ? txnPausePoint("memory-purge-resolve-first")
        : attempt === 2
          ? txnPausePoint("memory-purge-resolve-second")
          : txnPausePoint("memory-purge-resolve-last");
      if (resolvePause) await resolvePause;
      const lockedIds = [...targets.rows.keys()].sort();
      const locked = await withMemoryWriteLock(memory.primaryStore, lockedIds, async () => {
        const current = await resolvePurgeTargets(ctx, memory, ids as string[]);
        if (current.missing.length > 0) return { kind: "missing" as const, ids: current.missing };
        const currentIds = [...current.rows.keys()].sort();
        if (currentIds.length !== lockedIds.length || currentIds.some((id, i) => id !== lockedIds[i])) {
          return { kind: "changed" as const, rows: current.rows };
        }
        return { kind: "ran" as const, value: await this.runPurge(ctx, memory, current.rows) };
      }, { phase: "memory-purge" });
      if (locked.kind === "busy") return memoryBusyResponse(purgeCallerId(ctx));
      if (locked.kind === "unknown") return writeOutcomeUnknownResponse();
      if (locked.kind === "unavailable") return memoryLockUnavailableResponse();
      if (locked.value.kind === "missing") {
        return reply(404, { error: "memory_purge_target_missing", ids: locked.value.ids });
      }
      if (locked.value.kind === "changed") {
        targets = { rows: locked.value.rows, missing: [] };
        continue;
      }
      return locked.value.value;
    }
    return reply(409, {
      error: "memory_purge_targets_changed",
      message: "the rows this purge targets changed while it held their locks; nothing was deleted; retry the purge",
      ids: [...targets.rows.keys()].sort(),
    });
  }

  /** Steps 1-4, run while the caller holds every target id's lock. */
  private async runPurge(ctx: any, memory: any, targets: Map<string, Record<string, any>>): Promise<any> {
    // 1. ONE owned transaction per call: a failed read or history write aborts
    // every write in it. No pointer row is touched here (step 4).
    const historyIds = new Map<string, string>();
    try {
      await withOwnedTransaction(ctx, async (c) => {
        for (const id of targets.keys()) {
          const stored = await memory.get(id, c);
          if (!stored) throw new MissingTarget([id]);
          await memory.delete(id, c);
          // Test-only: the row delete is staged and the transaction has not
          // committed. The lock is held.
          const staged = txnPausePoint("memory-purge-staged");
          if (staged) await staged;
          const historyId = await recordMemoryDeletion({
            memoryId: id,
            memoryInstanceToken: stored.instanceToken ?? null,
            durability: stored.durability ?? null,
            actor: null,
            sourceClass: "admin",
          }, c);
          if (historyId) historyIds.set(id, historyId);
          // Test-only: every write of this target is staged and the transaction
          // has not committed. The lock is held.
          const commit = txnPausePoint("memory-purge-commit");
          if (commit) await commit;
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
    // Test-only: the delete transaction has committed and been confirmed; the
    // lock is still held.
    const committed = txnPausePoint("memory-purge-committed");
    if (committed) await committed;

    // 3. Attempt cleanup of history for rows still stored; confirm absence
    // after the cleanup commit. Failed cleanup is reported below.
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
    let pointerError: string | null = null;
    if (removedIds.length > 0) {
      try {
        await withOwnedTransaction(ctx, async (c) => {
          for (const id of removedIds) {
            if (!(await memory.get(id, c))) await deletePointerRowViaTable(id, c);
          }
        });
      } catch (err) {
        pointerError = errorText(err);
      }
    }
    const pointerLeft: string[] = [];
    let pointerConfirmationError: string | null = null;
    try {
      const pointers = await withOwnedTransaction(ctx, (c) => storedPointerIds(removedIds, c));
      if (pointers.size > 0) {
        await withOwnedTransaction(ctx, async (c) => {
          for (const id of removedIds) {
            if (pointers.has(id) && !(await memory.get(id, c))) pointerLeft.push(id);
          }
        });
      }
    } catch (err) {
      pointerConfirmationError = errorText(err);
    }

    if (historyLeft.size > 0) {
      const left = staleHistory.filter((h) => historyLeft.has(h.historyId));
      return reply(500, {
        error: "memory_purge_history_cleanup_unconfirmed",
        message: `these rows are still stored after the commit; ${historyError !== null
          ? `could not confirm deletion of their deletion-history records (${errorText(historyError)})`
          : "their deletion-history records were not deleted and are still stored"}`,
        ids: left.map((h) => h.memoryId),
        historyIds: left.map((h) => h.historyId),
        stillStoredIds: stillStored,
        removedIds,
      });
    }
    if (pointerError !== null || pointerConfirmationError !== null || pointerLeft.length > 0) {
      return reply(500, {
        error: "memory_purge_pointer_cleanup_failed",
        message: `${pointerError !== null
          ? `the pointer-row delete for rows in removedIds failed (${pointerError})`
          : pointerConfirmationError !== null
            ? `could not confirm pointer-row deletion for rows in removedIds (${pointerConfirmationError})`
            : "rows in removedIds still have a pointer row after its delete"}`,
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
