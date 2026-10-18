import { databases } from "harper";
import { stripUndeclaredMemoryAttributes } from "./memory-declared-attributes.js";
import { noteMemoryUpsert } from "./bm25-index-service.js";
import { writeBackCommittedRow } from "./write-back.js";
import { txnPausePoint } from "./txn-pause-point.js";
import { isJoinableTransaction } from "./request-transaction.js";

/** The row a promotion's Memory write produced: its owner, content and
 *  incarnation token. A row an earlier sweep recorded adds the fields that
 *  sweep wrote, re-checked at the stamp's first read. */
export interface PromotedRowIdentity {
  agentId: unknown;
  content: unknown;
  instanceToken: unknown;
  tags?: string[];
  visibility?: string;
  durability?: string;
  unstamped?: boolean;
}

/** The stamp's first read is not the row the promotion wrote: nothing stamped. */
export class PromotedRowChangedError extends Error {
  constructor(id: string) {
    super(`promotion-stamp: row ${id} is not the row this promotion wrote; no stamp written`);
    this.name = "PromotedRowChangedError";
  }
}

function isWrittenRow(row: any, written: PromotedRowIdentity | undefined): boolean {
  if (written == null || typeof written.instanceToken !== "string" || written.instanceToken.length === 0) return false;
  if (row.agentId !== written.agentId || row.content !== written.content ||
    row.instanceToken !== written.instanceToken) return false;
  if (written.unstamped && row.promotionStatus != null) return false;
  if (written.visibility !== undefined && row.visibility !== written.visibility) return false;
  if (written.durability !== undefined && row.durability !== written.durability) return false;
  if (written.tags !== undefined &&
    (!Array.isArray(row.tags) || !written.tags.every((tag) => row.tags.includes(tag)))) return false;
  return true;
}

// Called only after the promotion workflow has authorized and written a Memory
// through its resource (safety, embedding, ownership and provenance still run).
// Auto-promotion supplies its enumeration context: its Memory write used a
// separate agentContext, so that enumeration snapshot cannot see the new row.
// It also supplies the identity of the row it wrote; the stamp's first read
// must be that row. Manual promotion passes the context of the open
// transaction its Memory write used, and the stamp joins it.
export async function stampMemoryPromotion(
  id: string, reviewerId: string, decidedAt: string, enumerationContext?: any, stagedContext?: any,
  written?: PromotedRowIdentity,
): Promise<void> {
  const table = (databases as any).flair.Memory;
  const stamp = (stored: any) => {
    if (!stored) throw new Error(`Promotion memory ${id} was not written`);
    const row = { ...stored, promotionStatus: "approved", promotedBy: reviewerId, promotedAt: decidedAt };
    stripUndeclaredMemoryAttributes(row);
    return row;
  };
  if (isJoinableTransaction(stagedContext)) {
    const row = stamp(await table.get(id, stagedContext));
    await table.put(row, stagedContext);
    noteMemoryUpsert(row);
    return;
  }
  // Test-only: inert unless the fault-injection opt-in is armed.
  const beforeFirstRead = txnPausePoint("promotion-stamp-select");
  if (beforeFirstRead) await beforeFirstRead;
  const selected = await table.get(id, {});
  if (!selected) throw new Error(`Promotion memory ${id} was not written`);
  if (!isWrittenRow(selected, written)) throw new PromotedRowChangedError(id);
  const outcome = await writeBackCommittedRow(
    table,
    id,
    (stored) => ({ write: stamp(stored) }),
    { ctx: enumerationContext, label: "promotion-stamp", pausePre: () => txnPausePoint("promotion-stamp-pre"), pausePoint: () => txnPausePoint("promotion-stamp"), matchFields: ["content"], expectedRow: selected },
  );
  if ("write" in outcome) noteMemoryUpsert(outcome.write);
}

/** Stamp after a successful Memory write. A failure must not abort a sweep.
 * Auto-promotion uses this non-fatal wrapper and leaves its candidate pending
 * with `stamp_refused` (flair#2651), so the next sweep retries it; manual
 * promotion calls stampMemoryPromotion directly, so a stamp failure fails that
 * request. */
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
