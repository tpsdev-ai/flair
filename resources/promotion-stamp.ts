import { withDetachedTxn } from "./table-helpers.js";
import { databases } from "harper";
import { noteMemoryUpsert } from "./bm25-index-service.js";

// Called only after the promotion workflow has authorized and written a Memory
// through its resource (safety, embedding, ownership and provenance still run).
// Auto-promotion supplies its enumeration context: its Memory write used a
// separate agentContext, so that enumeration snapshot cannot see the new row.
// Manual promotion keeps the stamp in its own write transaction.
export async function stampMemoryPromotion(id: string, reviewerId: string, decidedAt: string, enumerationContext?: any): Promise<void> {
  const table = (databases as any).flair.Memory;
  const stored = await withDetachedTxn(enumerationContext, () => table.get(id));
  if (!stored) throw new Error(`Promotion memory ${id} was not written`);
  const row = { ...stored, promotionStatus: "approved", promotedBy: reviewerId, promotedAt: decidedAt };
  await withDetachedTxn(enumerationContext, () => table.put(row));
  noteMemoryUpsert(row);
}

/** Stamp after a successful Memory write. Failures must not abort a sweep or
 * leave a candidate pending (that re-writes the same claim next cycle). */
export async function stampMemoryPromotionIsolated(
  id: string, reviewerId: string, decidedAt: string, enumerationContext?: any,
): Promise<boolean> {
  try {
    await stampMemoryPromotion(id, reviewerId, decidedAt, enumerationContext);
    return true;
  } catch (err: any) {
    console.warn(`stampMemoryPromotion failed for ${id}: ${err?.message ?? err}`);
    return false;
  }
}
