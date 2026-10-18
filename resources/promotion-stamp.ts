import { databases } from "harper";
import { stripUndeclaredMemoryAttributes } from "./memory-declared-attributes.js";
import { noteMemoryUpsert } from "./bm25-index-service.js";
import { writeBackCommittedRow } from "./write-back.js";
import { txnPausePoint } from "./txn-pause-point.js";
import { isJoinableTransaction } from "./request-transaction.js";
import { promotionContentHash } from "./promotion-binding.js";
import { withMemoryWriteLock, withMemoryWriteLockOnce, type MemoryLockOutcome } from "./memory-write-lock.js";

/** The row a promotion's Memory write produced: its owner, content and
 *  incarnation token. */
export interface PromotedRowIdentity {
  agentId: unknown;
  content: unknown;
  instanceToken: unknown;
}

/** The stamp's first read is not the row the promotion wrote: nothing stamped. */
export class PromotedRowChangedError extends Error {
  constructor(id: string) {
    super(`promotion-stamp: row ${id} is not the row this promotion wrote; no stamp written`);
    this.name = "PromotedRowChangedError";
  }
}

/** The memory id's write lock answered something other than a completed
 *  callback: nothing was stamped. */
export class PromotionStampLockError extends Error {
  constructor(kind: MemoryLockOutcome<unknown>["kind"], id: string) {
    super(`promotion-stamp: the memory write lock for ${id} answered ${kind}; no stamp written`);
    this.name = "PromotionStampLockError";
  }
}

function isWrittenRow(row: any, written: PromotedRowIdentity | undefined): boolean {
  return written != null && typeof written.instanceToken === "string" && written.instanceToken.length > 0 &&
    row.agentId === written.agentId && row.content === written.content && row.instanceToken === written.instanceToken;
}

/** The incremental update a stamp writes: the verdict fields plus the hash of
 *  the EXACT stored, post-redaction content the verdict is bound to. */
function promotionStampUpdate(stored: any, reviewerId: string, decidedAt: string): Record<string, unknown> {
  return {
    promotionStatus: "approved",
    promotedBy: reviewerId,
    promotedAt: decidedAt,
    promotionContentHash: promotionContentHash(stored.content),
  };
}

/** Automatic stamping checks the written row's identity; both paths skip an
 * already mismatched content hash. */
function isStaleBasis(stored: any, written: PromotedRowIdentity | undefined): boolean {
  if (written != null && !isWrittenRow(stored, written)) return true;
  const bound = stored?.promotionContentHash;
  return typeof bound === "string" && bound.length > 0 && bound !== promotionContentHash(stored.content);
}

function memoryPrimaryStore(): unknown {
  return (databases as any)?.flair?.Memory?.primaryStore;
}

// Called only after the promotion workflow has authorized and written a Memory
// through its resource (safety, embedding, ownership and provenance still run).
// Auto-promotion supplies its enumeration context: its Memory write used a
// separate agentContext, so that enumeration snapshot cannot see the new row.
// It also supplies the identity of the row it wrote; the stamp's first read
// must be that row. Manual promotion passes the context of the open
// transaction its Memory write used, and the stamp joins it.
//
// Both stamps share the per-id Memory lock with owner PUT/PATCH and update
// only verdict fields. The automatic write confirms identity, content and hash.
export async function stampMemoryPromotion(
  id: string, reviewerId: string, decidedAt: string, enumerationContext?: any, stagedContext?: any,
  written?: PromotedRowIdentity,
): Promise<void> {
  const table = (databases as any).flair.Memory;
  if (isJoinableTransaction(stagedContext)) {
    // Manual promotion: the Memory write and this stamp share the caller's
    // transaction. The memory lock is taken for the stamp's own read/decision/
    // write; the enclosing transaction commits after it releases (the composed
    // limit in resources/memory-write-lock.ts).
    const outcome = await withMemoryWriteLock(memoryPrimaryStore(), [id], async () => {
      const row = await table.get(id, stagedContext);
      if (!row) throw new Error(`Promotion memory ${id} was not written`);
      if (isStaleBasis(row, written)) return false;
      // Test-only: inert unless the fault-injection opt-in is armed. The lock is
      // held and the caller's transaction is open.
      const paused = txnPausePoint("promotion-stamp-manual");
      if (paused) await paused;
      const update = promotionStampUpdate(row, reviewerId, decidedAt);
      await table.update(id, update, stagedContext);
      noteMemoryUpsert({ ...row, ...update });
      return true;
    }, { phase: "promotion-stamp-manual" });
    if (outcome.kind !== "done") throw new PromotionStampLockError(outcome.kind, id);
    return;
  }
  // Test-only: inert unless the fault-injection opt-in is armed.
  // Test-only: the promotion's Memory write has committed; the stamp has not
  // taken the lock yet. Inert unless the fault-injection opt-in is armed.
  const entry = txnPausePoint("promotion-stamp-entry");
  if (entry) await entry;
  const outcome = await withMemoryWriteLockOnce(memoryPrimaryStore(), [id], async () => {
    const beforeFirstRead = txnPausePoint("promotion-stamp-select");
    if (beforeFirstRead) await beforeFirstRead;
    const selected = await table.get(id, {});
    if (!selected) throw new Error(`Promotion memory ${id} was not written`);
    if (isStaleBasis(selected, written)) return null;
    const writeBack = await writeBackCommittedRow(
      table,
      id,
      (stored) => {
        const update = promotionStampUpdate(stored, reviewerId, decidedAt);
        return { update };
      },
      { ctx: enumerationContext, label: "promotion-stamp", pausePre: () => txnPausePoint("promotion-stamp-pre"), pausePoint: () => txnPausePoint("promotion-stamp"), matchFields: ["content", "promotionContentHash"], expectedRow: selected },
    );
    // Test-only: the write-back committed and the lock is still held.
    const committed = txnPausePoint("promotion-stamp-committed");
    if (committed) await committed;
    if ("update" in writeBack) noteMemoryUpsert({ ...selected, ...writeBack.update });
    return writeBack;
  }, { phase: "promotion-stamp-auto" });
  if (outcome.kind !== "done") throw new PromotionStampLockError(outcome.kind, id);
}

/** Stamp after a successful Memory write. Failures must not abort a sweep or
 * leave a candidate pending (that re-writes the same claim next cycle).
 * Auto-promotion uses this non-fatal wrapper; manual promotion calls
 * stampMemoryPromotion directly, so a stamp failure fails that request. */
export async function stampMemoryPromotionIsolated(
  id: string, reviewerId: string, decidedAt: string, enumerationContext?: any, written?: PromotedRowIdentity,
): Promise<boolean> {
  try {
    await stampMemoryPromotion(id, reviewerId, decidedAt, enumerationContext, undefined, written);
    return true;
  } catch (err: any) {
    console.warn(`stampMemoryPromotion failed for ${id}: ${err?.message ?? err}`);
    return false;
  }
}
