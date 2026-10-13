/**
 * memory-write-response.ts — which fields of a Memory row a write response
 * carries (flair#2561).
 *
 * - No Memory or feed write response carries the embedding fields
 *   (MEMORY_EMBEDDING_FIELDS: `embedding`, `embeddingModel`).
 *   withoutEmbeddingFields() drops them from the result a Memory post/put/patch
 *   response is built on and from the result of the admin `_reindex` re-PUT;
 *   the re-embed PATCH answers `{ id, updatedAt }` (resources/Memory.ts).
 * - The POST /FeedMemories response is built from the row the feed stored or
 *   matched: feedResponseFields() keeps the FEED_RESPONSE_WRITE_FIELDS, which
 *   the server decides for that row, and otherwise only the non-null-valued
 *   fields the request supplied (suppliedMemoryFields), each as stored. A field
 *   the row holds that the request did not send with a non-null value (text,
 *   metadata, subject, tags, ...) is not in the response.
 *
 * Pure data and functions: importing this module never loads Harper.
 */

import { protoSafeRecord } from "../src/lib/proto-safe-record.js";

/** The Memory fields no write response carries: the stored vector and its model stamp. */
export const MEMORY_EMBEDDING_FIELDS = Object.freeze(["embedding", "embeddingModel"] as const);

const EMBEDDING_FIELDS: ReadonlySet<string> = new Set(MEMORY_EMBEDDING_FIELDS);

/**
 * The fields of a feed write's response that the server decides for the row
 * it wrote or matched, reported whether or not the request sent them: the
 * row's identity and owner, its tier, visibility and expiry, its timestamps
 * and lifecycle state, its version link, and the server stamps.
 */
export const FEED_RESPONSE_WRITE_FIELDS = Object.freeze([
  "id",
  "written",
  "agentId",
  "durability",
  "visibility",
  "createdAt",
  "updatedAt",
  "expiresAt",
  "archived",
  "supersedes",
  "skillSubjectId",
  "instanceToken",
  "originatorInstanceId",
  "provenance",
] as const);

const WRITE_FIELDS: ReadonlySet<string> = new Set(FEED_RESPONSE_WRITE_FIELDS);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Response);
}

/**
 * The non-null-valued fields a write request supplies: each key of the request
 * body that holds a value other than undefined or null. A write reads them from
 * the body as the request sent it, before a stored row or a skill predecessor
 * is merged into that body.
 */
export function suppliedMemoryFields(body: unknown): ReadonlySet<string> {
  if (!isPlainRecord(body)) return new Set();
  return new Set(Object.keys(body).filter((key) => body[key] !== undefined && body[key] !== null));
}

/** A copy of `result` without MEMORY_EMBEDDING_FIELDS; a non-record is returned unchanged. */
export function withoutEmbeddingFields<T>(result: T): T {
  if (!isPlainRecord(result)) return result;
  const copy: Record<string, unknown> = { ...result };
  for (const field of MEMORY_EMBEDDING_FIELDS) delete copy[field];
  return copy as T;
}

/**
 * A copy of the feed row `row` holding the FEED_RESPONSE_WRITE_FIELDS and the
 * `supplied` fields (suppliedMemoryFields) it carries, each as stored, and
 * never an embedding field (a null-prototype record, protoSafeRecord). A
 * Response or a non-record is returned unchanged.
 */
export function feedResponseFields(row: unknown, supplied: ReadonlySet<string>): unknown {
  if (!isPlainRecord(row)) return row;
  const keys = Object.keys(row).filter((key) => !EMBEDDING_FIELDS.has(key) && (WRITE_FIELDS.has(key) || supplied.has(key)));
  return protoSafeRecord(row, { keys });
}
