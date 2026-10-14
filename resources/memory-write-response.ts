/**
 * memory-write-response.ts — which fields of a Memory row a write response
 * carries (flair#2561).
 *
 * - No Memory or feed write response carries the embedding fields
 *   (MEMORY_EMBEDDING_FIELDS: `embedding`, `embeddingModel`).
 *   withoutEmbeddingFields() drops them from the result a Memory post/put/patch
 *   response is built on and from the result of the admin `_reindex` re-PUT;
 *   the re-embed PATCH answers `{ id, updatedAt }` (resources/Memory.ts). It
 *   reports a result only in a shape it recognises: no value, a row-shaped
 *   record (isRowShaped) or an array of them. Any other result, a successful
 *   Response included, is replaced by the `write_response_withheld` refusal
 *   (withheldWriteResult); a refusal Response the write path built is returned
 *   as built (writeResultResponse), and a Response from the storage layer is
 *   replaced where it is received (storageResult).
 * - The POST /FeedMemories response is built from the row the feed stored or
 *   matched: feedResponseFields() keeps the FEED_RESPONSE_WRITE_FIELDS, which
 *   the server decides for that row, and otherwise only the non-null Memory
 *   attributes the request supplied (suppliedMemoryFields), each as stored;
 *   feedWriteResponse adds `redactedValues` when it is above zero. A field the
 *   row holds that the request did not send with a non-null value (text,
 *   metadata, subject, tags, ...) is not in the response.
 *
 * Pure data and functions: importing this module never loads Harper.
 */

import { MEMORY_ATTRIBUTES } from "../src/lib/memory-attributes.js";
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

/** The error a write answers with in place of a result it does not report (withheldWriteResult). */
export const WRITE_RESPONSE_WITHHELD = "write_response_withheld";

/**
 * The 500 `write_response_withheld` refusal a write answers with in place of a
 * result it does not report. It says the write completed and how to see the
 * row.
 */
export function withheldWriteResult(): Response {
  return Response.json({
    error: WRITE_RESPONSE_WITHHELD,
    message: "the write completed, but the server does not report its result; read the row to see what was stored",
  }, { status: 500 });
}

/**
 * A value a write received from the storage layer (a table put or patch). A
 * Response, whatever its status, is replaced by the `write_response_withheld`
 * refusal without its body being read; any other value is returned for the
 * write's exit to check (withoutEmbeddingFields). So every Response a write's
 * exit receives is a refusal the write path built or this refusal.
 */
export function storageResult<T>(value: T): T | Response {
  return value instanceof Response ? withheldWriteResult() : value;
}

/**
 * A write's result when it is a Response. Storage-layer Responses are replaced
 * where they are received (storageResult), so a Response that reaches a
 * write's exit is a refusal the write path built, a named error with no row
 * fields, or the `write_response_withheld` refusal. A refusal (a status
 * outside 200-299) is returned as built. A successful Response is replaced by
 * the `write_response_withheld` refusal without its body being read.
 */
export function writeResultResponse(response: Response): Response {
  if (!response.ok) return response;
  return withheldWriteResult();
}

/** The fields a write result holds besides the Memory attributes: the write signal. */
const WRITE_RESULT_FIELDS = Object.freeze(["written"] as const);

const ROW_FIELDS: ReadonlySet<string> = new Set<string>([...MEMORY_ATTRIBUTES, ...WRITE_RESULT_FIELDS]);

/** A plain object: an object whose prototype is Object.prototype or null (not an array, a Date, a Map, ...). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Whether `value` holds a key named `embedding` or `embeddingModel` at any
 * depth: in a nested object, or in an object inside an array. A typed array (a
 * vector) holds values and no keys. A value that contains itself (a cycle) is
 * treated as holding one, so the caller refuses it.
 */
function holdsEmbeddingKey(value: unknown, ancestors: Set<object> = new Set()): boolean {
  if (!value || typeof value !== "object" || ArrayBuffer.isView(value)) return false;
  if (ancestors.has(value)) return true;
  ancestors.add(value);
  const found = Array.isArray(value)
    ? value.some((item) => holdsEmbeddingKey(item, ancestors))
    : Object.entries(value).some(([key, item]) => EMBEDDING_FIELDS.has(key) || holdsEmbeddingKey(item, ancestors));
  ancestors.delete(value);
  return found;
}

/**
 * A row-shaped record: a plain object (isPlainObject) whose every key is a
 * Memory attribute (MEMORY_ATTRIBUTES) or `written`, and whose values hold no
 * `embedding` or `embeddingModel` key at any depth. A Memory row holds those
 * two fields only as top-level attributes, so removing those two keys from a
 * row-shaped record leaves neither anywhere in it. A record with any other key,
 * such as a wrapper around a row, or with either name nested in a value, is
 * not row-shaped.
 */
export function isRowShaped(value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false;
  return Object.entries(value).every(([key, item]) =>
    ROW_FIELDS.has(key) && (EMBEDDING_FIELDS.has(key) || !holdsEmbeddingKey(item)));
}

/**
 * A write result without MEMORY_EMBEDDING_FIELDS. No value (undefined or null)
 * is returned unchanged; a row-shaped record (isRowShaped) is copied without
 * them, and an array of row-shaped records likewise. A refusal Response is
 * returned as built (writeResultResponse). Any other result, a successful
 * Response, a record that is not row-shaped, an array holding anything else,
 * or a scalar, is replaced by the `write_response_withheld` refusal
 * (withheldWriteResult). The result a write reports therefore holds no key
 * named `embedding` or `embeddingModel` whatever the storage layer returns. On
 * Harper the results these writes receive are no value or row-shaped records
 * the write paths build, so no successful write is refused.
 */
export function withoutEmbeddingFields<T>(result: T): T {
  if (result === undefined || result === null) return result;
  if (result instanceof Response) return writeResultResponse(result) as T;
  if (Array.isArray(result)) {
    if (!result.every((item) => isRowShaped(item))) return withheldWriteResult() as T;
    return result.map((item) => withoutEmbeddingFields(item)) as T;
  }
  if (!isRowShaped(result)) return withheldWriteResult() as T;
  const copy: Record<string, unknown> = { ...result };
  for (const field of MEMORY_EMBEDDING_FIELDS) delete copy[field];
  return copy as T;
}

/**
 * A copy of the feed row `row` (a null-prototype record, protoSafeRecord)
 * holding the FEED_RESPONSE_WRITE_FIELDS it carries and the `supplied` fields
 * (suppliedMemoryFields) that are Memory attributes and that it carries, each
 * as stored, and never an embedding field. An array's records are copied
 * likewise. A refusal Response is returned as built (writeResultResponse).
 * Any other result, no value, a successful Response, a scalar, an array
 * holding a non-record, or a copy with `embedding` or `embeddingModel` nested
 * in a value, is replaced by the `write_response_withheld` refusal
 * (withheldWriteResult).
 */
export function feedResponseFields(row: unknown, supplied: ReadonlySet<string>): unknown {
  if (row instanceof Response) return writeResultResponse(row);
  if (Array.isArray(row)) {
    if (!row.every((item) => isPlainRecord(item))) return withheldWriteResult();
    const copies = row.map((item) => feedResponseFields(item, supplied));
    return copies.some((copy) => copy instanceof Response) ? withheldWriteResult() : copies;
  }
  if (!isPlainRecord(row)) return withheldWriteResult();
  const keys = Object.keys(row).filter((key) =>
    !EMBEDDING_FIELDS.has(key) && (WRITE_FIELDS.has(key) || (supplied.has(key) && ROW_FIELDS.has(key))));
  const copy = protoSafeRecord(row, { keys });
  return holdsEmbeddingKey(copy) ? withheldWriteResult() : copy;
}
