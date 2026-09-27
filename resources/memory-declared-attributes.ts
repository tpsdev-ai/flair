/**
 * memory-declared-attributes.ts — the "declared attributes only" guard
 * (flair#1940 slice 1 / A1' item 1). PURE: zero imports, so it is unit-
 * testable and callable from every Memory writer.
 *
 * WHY: Harper stores an attribute that is not DECLARED in the schema (the
 * `schemas/memory.graphql` ~32-35 note records this for `embeddingModel`;
 * the probe in test/unit/memory-declared-attributes.test.ts re-confirms it
 * against the pinned harper). So removing a field from the Memory schema does
 * NOT stop a raw writer from persisting it — a `Memory.put({..., hostSource})`
 * would still land. The only reliable stop is a whitelist applied on the way
 * IN, shared by every writer, so no path has to remember the rule again.
 *
 * The pointer inputs (`hostSource`, `hostSourceScope`, `hostSourceVisibility`)
 * are NOT declared Memory attributes after A1'; they are consumed by
 * Memory.post()/put() (and MemoryHostSource's own resource) BEFORE the content
 * reaches this guard, so the guard strips them like any other undeclared key.
 *
 * DECLARED_MEMORY_ATTRIBUTES is the schema's field list. A drift tripwire
 * (test/unit/memory-declared-attributes.test.ts) parses `type Memory` out of
 * schemas/memory.graphql and fails if this constant and the schema disagree,
 * so the whitelist can never silently fall behind the schema.
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
] as const);

const DECLARED = new Set<string>(DECLARED_MEMORY_ATTRIBUTES as readonly string[]);

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

const ALLOWED_UNDECLARED = new Set<string>(UNDECLARED_ALLOWED as readonly string[]);

/** True when `key` is a declared Memory attribute. */
export function isDeclaredMemoryAttribute(key: string): boolean {
  return DECLARED.has(key);
}

/**
 * Drop every UNDECLARED attribute from a Memory write body, IN PLACE, and
 * return the list of keys removed. A non-object body is returned untouched.
 * `id` is always kept (Harper assigns it when absent; a supplied id is the
 * caller's own key, never an undeclared field).
 */
export function stripUndeclaredMemoryAttributes(content: unknown): string[] {
  if (!content || typeof content !== "object" || Array.isArray(content)) return [];
  const obj = content as Record<string, unknown>;
  const removed: string[] = [];
  for (const key of Object.keys(obj)) {
    if (!DECLARED.has(key) && !ALLOWED_UNDECLARED.has(key)) {
      delete obj[key];
      removed.push(key);
    }
  }
  return removed;
}

/**
 * flair#1940 A1'' item 8 — the SAME declare-only whitelist applied to an
 * INBOUND federated Memory row before it is merged and written. A dirty pushed
 * row (a legacy direct-insert, or a raw writer that slipped a pointer field
 * past the writers) must not carry a pointer attribute onto the merged Memory
 * row; the named federation bookkeeping fields survive. Named seam so the
 * inbound direction is testable (resources/Federation.ts calls this).
 */
export function stripInboundMemoryRow(row: unknown): string[] {
  return stripUndeclaredMemoryAttributes(row);
}
