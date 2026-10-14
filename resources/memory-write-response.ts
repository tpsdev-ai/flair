/**
 * memory-write-response.ts — which fields of a Memory row a write response
 * carries (flair#2561).
 *
 * - No Memory or feed write response holds a key named `embedding` or
 *   `embeddingModel` (MEMORY_EMBEDDING_FIELDS) at any depth. The re-embed
 *   PATCH answers `{ id, updatedAt }` (resources/Memory.ts). The Memory
 *   post/put/patch responses and the admin `_reindex` re-PUT report their
 *   storage or write result through withoutEmbeddingFields() and return their
 *   final response through checkedWriteResponse(); the feed returns
 *   feedResponseFields(). Each returns either a refusal Response the write
 *   path built, or a fresh plain-JSON copy (plainJsonCopy) that holds neither
 *   key, or the `write_response_withheld` refusal (withheldWriteResult) when
 *   the value cannot be copied that way. A Response from the storage layer is
 *   replaced by that refusal where it is received (storageResult).
 * - The POST /FeedMemories response is built from the row the feed stored or
 *   matched: feedResponseFields() keeps the listed response fields
 *   (FEED_RESPONSE_WRITE_FIELDS) and otherwise only the non-null Memory
 *   attributes the request supplied (suppliedMemoryFields), each as stored;
 *   feedWriteResponse adds `redactedValues` when it is above zero. A field the
 *   row holds that the request did not send with a non-null value (text,
 *   metadata, subject, tags, ...) is not in the response.
 *
 * Pure data and functions: importing this module never loads Harper.
 */

import { MEMORY_ATTRIBUTES } from "../src/lib/memory-attributes.js";

/** The Memory fields no write response carries: the stored vector and its model stamp. */
export const MEMORY_EMBEDDING_FIELDS = Object.freeze(["embedding", "embeddingModel"] as const);

const EMBEDDING_FIELDS: ReadonlySet<string> = new Set(MEMORY_EMBEDDING_FIELDS);

/**
 * The listed response fields of a feed write: the fields of the row it wrote
 * or matched that the response reports whether or not the request sent them,
 * each as stored: the row's identity and owner, its tier, visibility and
 * expiry, its timestamps and lifecycle state, its version link, and the server
 * stamps.
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

/** The message of the `write_response_withheld` refusal; it does not say whether the write was stored. */
export const WRITE_RESPONSE_WITHHELD_MESSAGE =
  "the server does not report this write's result; read the row to see what is stored";

/**
 * The 500 `write_response_withheld` refusal a write answers with in place of a
 * result it does not report. It echoes no field of that result, does not say
 * whether the write was stored, and says how to see the row.
 */
export function withheldWriteResult(): Response {
  return Response.json({ error: WRITE_RESPONSE_WITHHELD, message: WRITE_RESPONSE_WITHHELD_MESSAGE }, { status: 500 });
}

/**
 * A value a write received from the storage layer (a table put or patch). A
 * Response, whatever its status, is replaced by the `write_response_withheld`
 * refusal; its body is not read. Any other value is returned for the write's
 * exit to check (withoutEmbeddingFields). So every Response a write's exit
 * receives is a refusal the write path built or this refusal.
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
 * the `write_response_withheld` refusal; its body is not read.
 */
export function writeResultResponse(response: Response): Response {
  if (!response.ok) return response;
  return withheldWriteResult();
}

/** The fields a write result holds besides the Memory attributes: the write signal. */
const WRITE_RESULT_FIELDS = Object.freeze(["written"] as const);

const ROW_FIELDS: ReadonlySet<string> = new Set<string>([...MEMORY_ATTRIBUTES, ...WRITE_RESULT_FIELDS]);

/** A plain object: an object whose prototype is Object.prototype or null (not an array, a Date, a Map, a typed array, ...). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** A plain-JSON value: what plainJsonCopy returns. */
type PlainJson = null | boolean | number | string | PlainJson[] | { [key: string]: PlainJson };

const NOT_COPIED: unique symbol = Symbol("not copied");

/**
 * A fresh plain-JSON copy of `value`, or NOT_COPIED. Each own property is read
 * once, from its property descriptor, so a getter is never called. The copy
 * holds only null-prototype objects (from plain objects), arrays (from plain
 * arrays without holes or extra properties), strings, finite numbers,
 * booleans and null. As JSON writes them, an object property whose value is
 * undefined is left out, and a non-finite number, or undefined in an array,
 * becomes null. NOT_COPIED is returned for anything else: a key named
 * `embedding` or `embeddingModel`, an accessor property, a symbol-keyed or
 * non-enumerable property, a typed array, a Date, a Map or another non-plain
 * object, a function, a symbol, a bigint, or a value that contains itself. The
 * copy is what a write returns, so the value checked is the value serialized.
 */
function plainJsonCopy(value: unknown, ancestors: Set<object> = new Set()): PlainJson | typeof NOT_COPIED {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null; // as JSON writes it
  if (typeof value !== "object" || ancestors.has(value)) return NOT_COPIED;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) return NOT_COPIED;
      const keys = Reflect.ownKeys(value);
      if (keys.length !== value.length + 1) return NOT_COPIED; // the indices and `length`, nothing else
      const items: PlainJson[] = [];
      for (let i = 0; i < value.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, i);
        if (!descriptor || !("value" in descriptor)) return NOT_COPIED;
        const item = descriptor.value === undefined ? null : plainJsonCopy(descriptor.value, ancestors); // as JSON writes it
        if (item === NOT_COPIED) return NOT_COPIED;
        items.push(item);
      }
      return items;
    }
    if (!isPlainObject(value)) return NOT_COPIED;
    const copy: { [key: string]: PlainJson } = Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string" || EMBEDDING_FIELDS.has(key)) return NOT_COPIED;
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!descriptor.enumerable || !("value" in descriptor)) return NOT_COPIED;
      if (descriptor.value === undefined) continue;
      const item = plainJsonCopy(descriptor.value, ancestors);
      if (item === NOT_COPIED) return NOT_COPIED;
      copy[key] = item;
    }
    return copy;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * A row-shaped record: a plain object (isPlainObject) whose every key is a
 * Memory attribute (MEMORY_ATTRIBUTES) or `written`, whose properties are all
 * enumerable data properties, and which plainJsonCopy can copy once its
 * top-level `embedding` and `embeddingModel` are set aside: no other value in
 * it holds either key at any depth. A record with any other key, such as a
 * wrapper around a row, is not row-shaped.
 */
export function isRowShaped(value: unknown): value is Record<string, unknown> {
  return rowCopy(value) !== NOT_COPIED;
}

/** The plain-JSON copy of a row-shaped record without its top-level embedding fields, or NOT_COPIED. */
function rowCopy(value: unknown): { [key: string]: PlainJson } | typeof NOT_COPIED {
  if (!isPlainObject(value)) return NOT_COPIED;
  const rest: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !ROW_FIELDS.has(key)) return NOT_COPIED;
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!descriptor.enumerable || !("value" in descriptor)) return NOT_COPIED;
    if (!EMBEDDING_FIELDS.has(key)) rest[key] = descriptor.value;
  }
  const copy = plainJsonCopy(rest);
  return copy === NOT_COPIED ? NOT_COPIED : (copy as { [key: string]: PlainJson });
}

/**
 * A write result without MEMORY_EMBEDDING_FIELDS. No value (undefined or null)
 * is returned unchanged. A row-shaped record (isRowShaped) is returned as a
 * plain-JSON copy without its top-level `embedding` and `embeddingModel`, and
 * an array of row-shaped records likewise. A refusal Response is returned as
 * built (writeResultResponse). Any other result, a successful Response, a
 * record that is not row-shaped, an array holding anything else, or a scalar,
 * is replaced by the `write_response_withheld` refusal (withheldWriteResult).
 * The value returned therefore holds no key named `embedding` or
 * `embeddingModel` whatever the storage layer returns. On Harper the results
 * these writes receive are no value or row-shaped records the write paths
 * build, so no successful write is refused.
 */
export function withoutEmbeddingFields<T>(result: T): T {
  if (result === undefined || result === null) return result;
  if (result instanceof Response) return writeResultResponse(result) as T;
  if (Array.isArray(result)) {
    if (Object.getPrototypeOf(result) !== Array.prototype) return withheldWriteResult() as T;
    const copies = Array.from({ length: result.length }, (_, i) => {
      const descriptor = Object.getOwnPropertyDescriptor(result, i);
      return descriptor && "value" in descriptor ? rowCopy(descriptor.value) : NOT_COPIED;
    });
    if (Reflect.ownKeys(result).length !== result.length + 1 || copies.some((copy) => copy === NOT_COPIED)) {
      return withheldWriteResult() as T;
    }
    return copies as T;
  }
  const copy = rowCopy(result);
  return (copy === NOT_COPIED ? withheldWriteResult() : copy) as T;
}

/**
 * A write's final response: a refusal Response is returned as built and a
 * successful Response is replaced (writeResultResponse); any other value is
 * returned as its plain-JSON copy (plainJsonCopy), which holds no key named
 * `embedding` or `embeddingModel` at any depth, or replaced by the
 * `write_response_withheld` refusal when it cannot be copied that way. No
 * value is returned unchanged.
 */
export function checkedWriteResponse(response: unknown): unknown {
  if (response === undefined || response === null) return response;
  if (response instanceof Response) return writeResultResponse(response);
  const copy = plainJsonCopy(response);
  return copy === NOT_COPIED ? withheldWriteResult() : copy;
}

/**
 * A feed row: a non-array object, not a Response, whose own properties are all
 * enumerable, string-keyed data properties and which has an own `id`. That is
 * a plain object the feed builds, or a row Harper's storage layer returns (an
 * instance of Harper's record class, so its prototype is not Object.prototype;
 * measured on real Harper: its fields are own enumerable data properties). A
 * Date, a Map, a typed array or a Response is not one.
 */
function isFeedRow(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || value instanceof Response || ArrayBuffer.isView(value)) return false;
  const keys = Reflect.ownKeys(value);
  if (!keys.includes("id")) return false;
  return keys.every((key) => {
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    return descriptor.enumerable === true && "value" in descriptor;
  });
}

/**
 * The response copy of one feed row (isFeedRow): a null-prototype record
 * holding the listed response fields (FEED_RESPONSE_WRITE_FIELDS) the row
 * carries and the `supplied` fields (suppliedMemoryFields) that are Memory
 * attributes and that it carries. Each such property is read once, from its
 * descriptor, and its value copied with plainJsonCopy, so the copy is what is
 * returned; NOT_COPIED when the value is not a feed row or a value cannot be
 * copied (an accessor, a typed array, a nested `embedding` or
 * `embeddingModel` key, ...).
 */
function feedRowCopy(row: unknown, supplied: ReadonlySet<string>): { [key: string]: PlainJson } | typeof NOT_COPIED {
  if (!isFeedRow(row)) return NOT_COPIED;
  const picked: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(row)) {
    if (EMBEDDING_FIELDS.has(key) || !(WRITE_FIELDS.has(key) || (supplied.has(key) && ROW_FIELDS.has(key)))) continue;
    picked[key] = Object.getOwnPropertyDescriptor(row, key)!.value;
  }
  const copy = plainJsonCopy(picked);
  return copy === NOT_COPIED ? NOT_COPIED : (copy as { [key: string]: PlainJson });
}

/**
 * The response to a feed write's row: feedRowCopy of it, and of each row of an
 * array of rows. A refusal Response is returned as built
 * (writeResultResponse). Any other result, no value, a successful Response, a
 * scalar, an object that is not a feed row (isFeedRow) such as a Date, an
 * array holding anything else, or a row feedRowCopy cannot copy, is replaced
 * by the `write_response_withheld` refusal (withheldWriteResult).
 */
export function feedResponseFields(row: unknown, supplied: ReadonlySet<string>): unknown {
  if (row instanceof Response) return writeResultResponse(row);
  if (Array.isArray(row)) {
    if (Object.getPrototypeOf(row) !== Array.prototype || Reflect.ownKeys(row).length !== row.length + 1) return withheldWriteResult();
    const copies = Array.from({ length: row.length }, (_, i) => {
      const descriptor = Object.getOwnPropertyDescriptor(row, i);
      return descriptor && "value" in descriptor ? feedRowCopy(descriptor.value, supplied) : NOT_COPIED;
    });
    return copies.some((copy) => copy === NOT_COPIED) ? withheldWriteResult() : copies;
  }
  const copy = feedRowCopy(row, supplied);
  return copy === NOT_COPIED ? withheldWriteResult() : copy;
}
