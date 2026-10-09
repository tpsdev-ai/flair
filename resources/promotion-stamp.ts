import { databases } from "harper";
import { stripUndeclaredMemoryAttributes } from "./memory-declared-attributes.js";
import { noteMemoryUpsert } from "./bm25-index-service.js";
import { writeBackCommittedRow } from "./write-back.js";
import { isJoinableTransaction } from "./request-transaction.js";

// Called only after the promotion workflow has authorized and written a Memory
// through its resource (safety, embedding, ownership and provenance still run).
// Auto-promotion supplies its enumeration context: its Memory write used a
// separate agentContext, so that enumeration snapshot cannot see the new row.
// Manual promotion passes the context of the open transaction its Memory write
// used, and the stamp joins it.
export async function stampMemoryPromotion(id: string, reviewerId: string, decidedAt: string, enumerationContext?: any, stagedContext?: any): Promise<void> {
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
  const outcome = await writeBackCommittedRow(
    table,
    id,
    (stored) => ({ write: stamp(stored) }),
    { ctx: enumerationContext, label: "promotion-stamp", pausePre: "promotion-stamp-pre", pausePoint: "promotion-stamp", matchFields: ["content"] },
  );
  if ("write" in outcome) noteMemoryUpsert(outcome.write);
}

/** Stamp after a successful Memory write. Failures must not abort a sweep or
 * leave a candidate pending (that re-writes the same claim next cycle).
 * Auto-promotion uses this non-fatal wrapper; manual promotion calls
 * stampMemoryPromotion directly, so a stamp failure fails that request. */
export async function stampMemoryPromotionIsolated(
  id: string, reviewerId: string, decidedAt: string, enumerationContext?: any, stagedContext?: any,
): Promise<boolean> {
  try {
    await stampMemoryPromotion(id, reviewerId, decidedAt, enumerationContext, stagedContext);
    return true;
  } catch (err: any) {
    console.warn(`stampMemoryPromotion failed for ${id}: ${err?.message ?? err}`);
    return false;
  }
}
