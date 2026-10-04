/** Shared Memory field contract for resource writers and federation readers.
 * Kept under src so the CLI build can include it within its rootDir; the
 * server build also emits this dependency under dist/src/lib.
 * Pure data: importing this contract never loads Harper.
 */

/** Every DECLARED attribute of `type Memory` in schemas/memory.graphql, in
 *  schema order. Keep in sync with the schema (the drift test enforces it). */
export const DECLARED_MEMORY_ATTRIBUTES = Object.freeze([
  "id",
  "agentId",
  "content",
  "contentHash",
  "trigger",
  "visibility",
  "embedding",
  "embeddingModel",
  "tags",
  "durability",
  "source",
  "type",
  "createdAt",
  "updatedAt",
  "instanceToken",
  "expiresAt",
  "retrievalCount",
  "lastRetrieved",
  "usageCount",
  "promotionStatus",
  "promotedAt",
  "promotedBy",
  "archived",
  "archivedAt",
  "archivedBy",
  "parentId",
  "derivedFrom",
  "sessionId",
  "lastReflected",
  "supersedes",
  "subject",
  "summary",
  "validFrom",
  "validTo",
  "_safetyFlags",
  "provenance",
  "originatorInstanceId",
  "metadata",
  "entities",
  "skillSubjectId",
] as const);

/** Pre-existing UNDECLARED attributes the codebase deliberately stores on a
 *  Memory row and must keep (the guard's job is the POINTER, not these).
 *  This is an EXPLICIT, NAMED list measured against a live store (A1'' item 1)
 *  — never derived from the schema, because the schema is not the source of
 *  truth for what is on disk:
 *    - `meta`   — the continuity-journal payload {seq, processUUID, sessionId,
 *                 hook} written by the capture path (PUT /Memory/<id>,
 *                 flair#1257 slice 3); Kern's slice-2 ruling settled that it
 *                 round-trips as an undeclared field, and
 *                 test/integration/continuity-rem-promotion-1257.test.ts pins
 *                 that. It is not a flat String, so declaring it would change
 *                 the stored shape.
 *    - `kind`   — carried on a couple of older rows.
 *    - `_originatorInstanceId`, `_syncedFrom`, `_syncedAt` — federation
 *                 bookkeeping stamped by the RECEIVER at merge time
 *                 (resources/Federation.ts's mergeRecord) on every synced row.
 *  Any OTHER undeclared key (in particular any pointer input) is stripped. */
export const UNDECLARED_ALLOWED = Object.freeze([
  "meta",
  "kind",
  "_originatorInstanceId",
  "_syncedFrom",
  "_syncedAt",
] as const);

/** Every field retained by Memory writers and the inbound federation guard. */
export const MEMORY_ATTRIBUTES = Object.freeze([
  ...DECLARED_MEMORY_ATTRIBUTES,
  ...UNDECLARED_ALLOWED,
] as const);
