/**
 * Safe read-modify-write helper for Harper tables.
 *
 * Harper's `put()` is FULL RECORD REPLACEMENT. If you pass a partial
 * object, all missing fields (including embeddings!) are permanently
 * deleted. This helper ensures you always read the full record first.
 *
 * Usage:
 *   import { patchRecord } from "./table-helpers.js";
 *   await patchRecord(tables.Memory, id, { lastReflected: now });
 */

export async function patchRecord(
  table: any,
  id: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const existing = await table.get(id);
  if (!existing) throw new Error(`Record ${id} not found`);
  await table.put({ ...existing, ...patch });
}

/**
 * Fire-and-forget variant — swallows errors silently.
 * Use for best-effort metadata updates (lastReflected, lastRetrieved, etc.)
 * where a failure should never break the calling request.
 */
export function patchRecordSilent(
  table: any,
  id: string,
  patch: Record<string, unknown>,
): void {
  patchRecord(table, id, patch).catch(() => {});
}

// ── RULE ──────────────────────────────────────────────────────────────────────
// Never call `tables.X.put(partial)` directly anywhere in Flair resources.
// Harper put() = FULL RECORD REPLACEMENT. Missing fields are deleted permanently.
// Always use patchRecord() or patchRecordSilent().
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detach ctx.transaction while `fn` runs, then restore.
 *
 * Why: when a request does two table reads in sequence (e.g. MemoryGrant.search
 * then Memory.search), the first generator drains and leaves its transaction
 * CLOSED at the tail of ctx.transaction's linked chain. Harper's txnForContext
 * (Table.js ~3633) walks that chain when opening a transaction for the second
 * table and inherits the CLOSED state onto the fresh transaction — which then
 * silently reads zero rows.
 *
 * Clearing ctx.transaction forces Harper to build a brand-new ImmediateTransaction
 * for the inner call. Table.search captures that transaction synchronously into
 * its result generator's closure, so the saved chain can be restored immediately
 * without affecting the streaming read.
 *
 * Use this whenever a resource method reads one table, then reads another in
 * the same request context.
 */
export function withDetachedTxn<T>(ctx: any, fn: () => T): T {
  if (!ctx) return fn();
  const saved = ctx.transaction;
  ctx.transaction = undefined;
  try {
    return fn();
  } finally {
    ctx.transaction = saved;
  }
}
