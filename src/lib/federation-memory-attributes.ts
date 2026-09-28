/**
 * federation-memory-attributes.ts — the Memory attributes the OUTBOUND
 * federation reader may project (flair#1940 slice 1, A1'' item 8).
 *
 * The outbound reader projects declared Memory attributes. The inbound merge
 * removes undeclared attributes except the named bookkeeping fields, so a host
 * pointer can never ride a federated Memory row even though the pointer now
 * lives in its own, unfederated table.
 *
 * The CLI build (tsconfig.cli, rootDir src) cannot import from resources/, so
 * this list is mirrored here; `test/unit/federation-memory-whitelist-1940.test.ts`
 * asserts that this mirror equals the resource lists, so the two cannot drift.
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
  // Named undeclared bookkeeping fields kept on a Memory row.
  "meta",
  "kind",
  "_originatorInstanceId",
  "_syncedFrom",
  "_syncedAt",
] as const);

export const FEDERATION_MEMORY_UNDECLARED = Object.freeze([
  "meta",
  "kind",
  "_originatorInstanceId",
  "_syncedFrom",
  "_syncedAt",
] as const);

/** The DECLARED subset, safe as a Harper `get_attributes` projection: Harper
 *  rejects an UNDECLARED attribute in a projection ("unknown attribute"), and
 *  the receiver stamps the bookkeeping fields itself, so the outbound reader
 *  projects only declared attributes. */
export const FEDERATION_MEMORY_SELECT = Object.freeze(
  FEDERATION_MEMORY_ATTRIBUTES.filter(
    (a) => !(FEDERATION_MEMORY_UNDECLARED as readonly string[]).includes(a),
  ),
);

