/**
 * memory-declared-attributes.ts — the declared Memory attributes guard
 * (flair#1940 slice 1 / A1' item 1). PURE: data-only imports, so it is unit-
 * testable and callable from every Memory writer.
 *
 * WHY: Harper stores an attribute that is not DECLARED in the schema (the
 * `schemas/memory.graphql` ~32-35 note records this for `embeddingModel`; the
 * pinned harper re-confirms it). So removing a field from the Memory schema
 * does NOT stop a raw writer from persisting it — a
 * `Memory.put({..., hostSource})` would still land. The one-shot real-Harper
 * probe is `test/repro/harper-undeclared-attr-probe.ts`; the unit test checks
 * whitelist behavior and schema drift. The named application write paths remove
 * pointer fields before persisting Memory rows. Federation filters its outbound
 * and inbound Memory rows separately. Trusted raw table operations remain
 * outside these resource guards.
 *
 * The pointer inputs (`hostSource`, `hostSourceScope`, `hostSourceVisibility`)
 * are NOT declared Memory attributes after A1'. Only `Memory.post()` and
 * `Memory.put()` accept pointer inputs; the `MemoryHostSource` resource refuses
 * every REST write verb. They are consumed BEFORE the content reaches this
 * guard, so the guard strips them like any other undeclared key.
 *
 * DECLARED_MEMORY_ATTRIBUTES is the schema's field list. A drift tripwire
 * (test/unit/memory-declared-attributes.test.ts) parses `type Memory` out of
 * schemas/memory.graphql and fails if this constant and the schema disagree,
 * so the whitelist can never silently fall behind the schema.
 */

import { DECLARED_MEMORY_ATTRIBUTES, MEMORY_ATTRIBUTES } from "../src/lib/memory-attributes.js";
export { DECLARED_MEMORY_ATTRIBUTES, UNDECLARED_ALLOWED } from "../src/lib/memory-attributes.js";

const DECLARED = new Set<string>(DECLARED_MEMORY_ATTRIBUTES);
const ALLOWED = new Set<string>(MEMORY_ATTRIBUTES);

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
    if (!ALLOWED.has(key)) {
      delete obj[key];
      removed.push(key);
    }
  }
  return removed;
}

/**
 * flair#1940 A1-iv item 3 — the SERVER-STAMPED fields a client body may never
 * set. The declared-attributes whitelist KEEPS these (they are declared/named),
 * so a whitelist alone does not stop forgery: a client could PUT a
 * `provenance` or an `instanceToken` that then reads as if the server stamped
 * it. Memory's REST write paths remove `instanceToken` and `provenance` from the
 * request body. `originatorInstanceId` is handled in #1965. `post()`/`put()` re-stamp `provenance` (via `buildProvenance`) and
 * `instanceToken` after the strip; the other writers strip and preserve the
 * stored value.
 */
export const SERVER_STAMPED_MEMORY_FIELDS = Object.freeze([
  "instanceToken",
  "provenance",
] as const);

const SERVER_STAMPED = new Set<string>(SERVER_STAMPED_MEMORY_FIELDS as readonly string[]);

/** Strip every server-stamped field from a write body, IN PLACE. Returns removed keys. */
export function stripServerStampedFields(content: unknown): string[] {
  if (!content || typeof content !== "object" || Array.isArray(content)) return [];
  const obj = content as Record<string, unknown>;
  const removed: string[] = [];
  for (const key of Object.keys(obj)) {
    if (SERVER_STAMPED.has(key)) {
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
