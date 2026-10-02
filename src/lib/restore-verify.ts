/**
 * restore-verify.ts — the field contract `flair restore` verifies against
 * (flair#2226). Pure data + pure functions (no Harper import), so it is usable
 * from the restore command and unit-testable.
 *
 * #2215 confirmed a restored row is READABLE at its archived id with the
 * archived owner. It did not confirm the CONTENT landed: a pre-existing row at
 * the same id passes. Restore now compares the archived row against the
 * restored row over the fields the SERVER PRESERVES on a write — the fields a
 * raw byte comparison would have to exclude because the write path restamps or
 * re-derives them.
 *
 * Which fields each write path preserves, restamps or drops, from the code:
 *
 * Memory.put() (resources/Memory.ts):
 *   - restamped: `updatedAt` (line 1565), `provenance` (line 1799),
 *     `_safetyFlags` (line 1702 — cleared when the rescan is clean), and the
 *     server-stamped `instanceToken` (line 1772 — a new UUID on create, the
 *     stored token preserved on update).
 *   - derived from the target instance, never from the archive:
 *     `originatorInstanceId` (line 1814) and the receiver bookkeeping
 *     `_originatorInstanceId`/`_syncedFrom`/`_syncedAt` (line 1818): a create
 *     stamps/drops them, an update keeps the STORED value.
 *   - derived at READ time, not stored: `retrievalCount`/`lastRetrieved`
 *     (overlaid from MemoryHitStat; schemas/memory.graphql MemoryHitStat).
 *   - server-derived from the content text: `embedding`/`embeddingModel`
 *     (put() recomputes a vector when the archive carries none). Not compared.
 *   - defaulted only when the archive omits them (so an archived value is
 *     preserved): `visibility` (line 1647), `createdAt` (line 1568),
 *     `archived` (line 1567), `archivedAt` (line 1758), `expiresAt`
 *     (lines 1666-1669), `validFrom` (lines 1680-1681).
 *   - preserved verbatim and compared: the remaining declared attributes plus
 *     the named retained `meta`/`kind` (resources/memory-declared-attributes.ts).
 *
 * Soul.put() (resources/Soul.ts):
 *   - restamped on every write: `updatedAt` (line 108) and `provenance`
 *     (line 19 via enforceWriteAuth).
 *   - derived from the target instance: `originatorInstanceId` (line 116).
 *   - preserved verbatim: `id`, `agentId`, `key`, `value`, `priority`,
 *     `metadata`, `durability`, `createdAt`.
 *
 * Agent rows keep the #2215 id-only check: Agent.put() deletes `createdAt` and
 * `publicKey` from the body (resources/Agent.ts lines 159-160) and restamps
 * `updatedAt`, so its archived columns do not round-trip either.
 *
 * A field is compared only when the ARCHIVED row carries it (a legacy row's
 * omitted column must not be demanded back). `undefined` and `null` compare
 * equal; objects compare with sorted keys; arrays compare in order.
 */

/** The server-preserved columns restore compares per table. */
export const RESTORE_PRESERVED_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  Memory: Object.freeze([
    "id", "agentId", "content", "contentHash", "trigger", "visibility",
    "tags", "durability", "source", "type",
    "createdAt", "expiresAt", "usageCount", "promotionStatus", "promotedAt",
    "promotedBy", "archived", "archivedAt", "archivedBy", "parentId",
    "derivedFrom", "sessionId", "lastReflected", "supersedes", "subject",
    "summary", "validFrom", "validTo", "metadata", "entities",
    "meta", "kind",
  ]),
  Soul: Object.freeze([
    "id", "agentId", "key", "value", "priority", "metadata", "durability", "createdAt",
  ]),
});

/** Absent (undefined) and explicit null mean the same thing here: no value. */
function normalize(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) out[key] = normalize(src[key]);
    return out;
  }
  return value;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

/**
 * Compare the archived row against the restored row over the preserved fields
 * and return the NAMES of the fields that differ. Values are never returned,
 * so a caller can log the mismatch without leaking record content.
 * Non-`Memory`/`Soul` tables have no extra compared fields and return `[]`.
 */
export function comparePreservedFields(table: string, archived: unknown, restored: unknown): string[] {
  const fields = RESTORE_PRESERVED_FIELDS[table] ?? [];
  if (!archived || typeof archived !== "object" || Array.isArray(archived)) return [];
  if (!restored || typeof restored !== "object" || Array.isArray(restored)) return [];
  const from = archived as Record<string, unknown>;
  const to = restored as Record<string, unknown>;
  const mismatched: string[] = [];
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(from, field)) continue;
    if (!sameValue(from[field], to[field])) mismatched.push(field);
  }
  return mismatched;
}
