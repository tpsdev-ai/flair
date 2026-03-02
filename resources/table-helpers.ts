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

// ── RULE ──────────────────────────────────────────────────────────────────────
// Never call `tables.X.put(partial)` directly anywhere in Flair resources.
// Harper put() = FULL RECORD REPLACEMENT. Missing fields are deleted permanently.
// Always use patchRecord() or patchRecordSilent().
// ─────────────────────────────────────────────────────────────────────────────
