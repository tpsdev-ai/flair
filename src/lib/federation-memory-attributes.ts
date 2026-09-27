/**
 * federation-memory-attributes.ts — the Memory attributes the OUTBOUND
 * federation reader may project (flair#1940 slice 1, A1'' item 8).
 *
 * The Memory writers persist ONLY declared attributes plus the named
 * undeclared bookkeeping fields (resources/memory-declared-attributes.ts's
 * `DECLARED_MEMORY_ATTRIBUTES` + `UNDECLARED_ALLOWED`). Federation must apply
 * the SAME whitelist when it READS a Memory row to push, so a dirty row (a
 * legacy direct-insert, or a raw writer) cannot carry a pointer field
 * (`hostSource` / `hostSourceScope` / `hostSourceVisibility`) off the instance
 * even though the pointer now lives in its own, unfederated table.
 *
 * The CLI build (tsconfig.cli, rootDir src) cannot import from resources/, so
 * this list is mirrored here; test/unit/federation-memory-attributes.test.ts
 * asserts it equals resources' declared + named lists, so the two cannot drift.
 */
export const FEDERATION_MEMORY_ATTRIBUTES = Object.freeze([
  // Declared Memory attributes (schemas/memory.graphql), in schema order.
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
  // Named undeclared bookkeeping fields kept on a Memory row.
  "meta",
  "kind",
  "_originatorInstanceId",
  "_syncedFrom",
  "_syncedAt",
] as const);
