import { databases } from "harper";
import { stripUndeclaredMemoryAttributes } from "./memory-declared-attributes.js";
import { noteMemoryUpsert } from "./bm25-index-service.js";
import { writeBackCommittedRow } from "./write-back.js";

// Called only after the promotion workflow has authorized and written a Memory
// through its resource (safety, embedding, ownership and provenance still run).
// Auto-promotion supplies its enumeration context: its Memory write used a
// separate agentContext, so that enumeration snapshot cannot see the new row.
// flair#2354: the stamp is one owned write-back — the row is read inside the
// transaction, the stamp is built from THAT read, and a concurrent change is
// retried from the committed row rather than reverted by a stale copy.
export async function stampMemoryPromotion(id: string, reviewerId: string, decidedAt: string, enumerationContext?: any): Promise<void> {
  const table = (databases as any).flair.Memory;
  const outcome = await writeBackCommittedRow(
    table,
    id,
    (stored) => {
      if (!stored) throw new Error(`Promotion memory ${id} was not written`);
      const row = { ...stored, promotionStatus: "approved", promotedBy: reviewerId, promotedAt: decidedAt };
      stripUndeclaredMemoryAttributes(row);
      return { write: row };
    },
    { ctx: enumerationContext, label: "promotion-stamp", pausePre: "promotion-stamp-pre", pausePoint: "promotion-stamp" },
  );
  if ("write" in outcome) noteMemoryUpsert(outcome.write);
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
