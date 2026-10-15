/**
 * memory-write-response.ts — the responses Memory and feed writes build
 * (flair#2561).
 *
 * Every covered write exit (Memory POST, PUT and PATCH, a skill write, the
 * admin `_reindex` re-PUT, the re-embed PATCH and POST /FeedMemories) builds
 * its response with buildFromAllowlist(): a fresh plain object holding only
 * the fields its rules name, each copied only when its value has the rule's
 * type (a string, an integer or finite number, a boolean, null where the rule
 * allows it, a fresh array of strings, or a fresh object built the same way).
 * Nothing is spread, cloned or iterated from a storage or write result: the
 * builder reads only the named fields. No rule names `embedding` or
 * `embeddingModel`, and no built value can hold a key, so no write response
 * holds either key, whatever the storage layer returns. A required field that
 * is missing or of another type, and a successful Response, are answered with
 * the `write_response_withheld` refusal (withheldWriteResult); a refusal a
 * write path built is returned as built (writeResultResponse), and a Response
 * from the storage layer is replaced by the withheld refusal where it is
 * received (storageResult).
 *
 * The POST /FeedMemories response holds the listed response fields
 * (FEED_RESPONSE_WRITE_FIELDS) and the non-null Memory attributes the request
 * supplied (suppliedMemoryFields), each read from the row the feed stored or
 * matched and copied when it has its schema type (MEMORY_ATTRIBUTE_RULES), plus
 * `redactedValues` when it is above zero.
 *
 * Pure data and functions: importing this module never loads Harper.
 */

/** The Memory fields no write response holds: the stored vector and its model stamp. */
export const MEMORY_EMBEDDING_FIELDS = Object.freeze(["embedding", "embeddingModel"] as const);

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
 * A value a write received from the storage layer (a table create, put or
 * patch). A Response, whatever its status, is replaced by the
 * `write_response_withheld` refusal; its body is not read. Any other value is
 * returned; the write's exit reads nothing from it but whether it is a
 * Response.
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

/** The type a response field must have to be copied. */
export type FieldRule =
  | { readonly type: "string" | "integer" | "number" | "boolean" | "strings"; readonly nullable?: boolean; readonly required?: boolean }
  | { readonly type: "object"; readonly fields: FieldRules; readonly required?: boolean };

/** The fields a response may hold, by name. */
export type FieldRules = Readonly<Record<string, FieldRule>>;

/** The most strings a "strings" field copies; a longer list is not copied. */
const MAX_STRINGS = 10_000;

const SKIP: unique symbol = Symbol("skip");

/**
 * The value of the field `name` of `source`: one property read, or undefined
 * when `source` is not an object or the read throws. Nothing else of `source`
 * is read.
 */
function namedField(source: unknown, name: string): unknown {
  if (source === null || (typeof source !== "object" && typeof source !== "function")) return undefined;
  try {
    return (source as Record<string, unknown>)[name];
  } catch {
    return undefined;
  }
}

/** `value` as `rule`'s type (a fresh array or object for those types), or SKIP. */
function typedValue(value: unknown, rule: FieldRule): unknown {
  if (value === null) return rule.type !== "object" && rule.nullable === true ? null : SKIP;
  switch (rule.type) {
    case "string":
      return typeof value === "string" ? value : SKIP;
    case "integer":
      return Number.isSafeInteger(value) ? value : SKIP;
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? value : SKIP;
    case "boolean":
      return typeof value === "boolean" ? value : SKIP;
    case "strings": {
      if (!Array.isArray(value)) return SKIP;
      const length = value.length;
      if (!Number.isSafeInteger(length) || length > MAX_STRINGS) return SKIP;
      const strings: string[] = [];
      for (let i = 0; i < length; i++) {
        const item = namedField(value, String(i));
        if (typeof item !== "string") return SKIP;
        strings.push(item);
      }
      return strings;
    }
    case "object": {
      const built = buildFromAllowlist(value, rule.fields);
      return built instanceof Response ? SKIP : built;
    }
  }
}

/**
 * A response built from `source` by allowlist: a fresh plain object holding,
 * for each field `rules` names (and `names` keeps, when given), the value of
 * that field of `source` when it has the rule's type (typedValue). Each named
 * field is read once (namedField); nothing else of `source` is read, so a
 * Date, a Map, a wrapper, a hidden or extra element and any nested object
 * contribute nothing but the named, typed values. A field whose value is
 * undefined or of another type is left out, unless the rule marks it
 * required: then the `write_response_withheld` refusal is returned.
 */
export function buildFromAllowlist(source: unknown, rules: FieldRules, names?: ReadonlySet<string>): Record<string, unknown> | Response {
  const built: Record<string, unknown> = {};
  for (const [name, rule] of Object.entries(rules)) {
    if (names && !names.has(name)) continue;
    const value = namedField(source, name);
    const typed = value === undefined ? SKIP : typedValue(value, rule);
    if (typed === SKIP) {
      if (rule.required === true) return withheldWriteResult();
      continue;
    }
    built[name] = typed;
  }
  return built;
}

/** A field of a stored row, nullable as stored values are. */
const STRING: FieldRule = Object.freeze({ type: "string", nullable: true });
const INTEGER: FieldRule = Object.freeze({ type: "integer", nullable: true });
const BOOLEAN: FieldRule = Object.freeze({ type: "boolean", nullable: true });
const STRINGS: FieldRule = Object.freeze({ type: "strings", nullable: true });

/**
 * The Memory attributes a feed response may report, each with its type in
 * schemas/memory.graphql (String, Int, Boolean, [String]), and the retained
 * undeclared strings (`kind` and the federation bookkeeping). `id` is a
 * required string. `embedding`, `embeddingModel` and the object-valued `meta`
 * are not listed, so no response holds them.
 */
export const MEMORY_ATTRIBUTE_RULES: FieldRules = Object.freeze({
  id: Object.freeze({ type: "string", required: true }),
  agentId: STRING, content: STRING, contentHash: STRING, trigger: STRING, visibility: STRING,
  tags: STRINGS, durability: STRING, source: STRING, type: STRING, createdAt: STRING, updatedAt: STRING,
  instanceToken: STRING, expiresAt: STRING, retrievalCount: INTEGER, lastRetrieved: STRING, usageCount: INTEGER,
  promotionStatus: STRING, promotedAt: STRING, promotedBy: STRING, archived: BOOLEAN, archivedAt: STRING,
  archivedBy: STRING, parentId: STRING, derivedFrom: STRINGS, sessionId: STRING, lastReflected: STRING,
  supersedes: STRING, subject: STRING, summary: STRING, validFrom: STRING, validTo: STRING, _safetyFlags: STRINGS,
  provenance: STRING, originatorInstanceId: STRING, metadata: STRING, entities: STRINGS, skillSubjectId: STRING,
  kind: STRING, _originatorInstanceId: STRING, _syncedFrom: STRING, _syncedAt: STRING,
  written: Object.freeze({ type: "boolean" }),
});

/** The `stored` text fields of a redacted write's response. */
export const STORED_TEXT_RULES: FieldRules = Object.freeze({
  content: Object.freeze({ type: "string" }),
  summary: Object.freeze({ type: "string" }),
  trigger: Object.freeze({ type: "string" }),
});

/** The redaction fields a write response adds when its count is above zero. */
export const REDACTION_RULES: FieldRules = Object.freeze({
  redactedValues: Object.freeze({ type: "integer" }),
  stored: Object.freeze({ type: "object", fields: STORED_TEXT_RULES }),
});

/**
 * The response to a feed write (feedWriteResponse): built by allowlist from
 * the row the feed stored or matched, holding the listed response fields and
 * the `supplied` fields (suppliedMemoryFields) that MEMORY_ATTRIBUTE_RULES
 * names, each when it has its schema type. A refusal Response is returned as
 * built (writeResultResponse); a row with no string `id`, an absent result
 * included, is answered with the `write_response_withheld` refusal.
 */
export function feedResponseFields(row: unknown, supplied: ReadonlySet<string>): Record<string, unknown> | Response {
  if (row instanceof Response) return writeResultResponse(row);
  const names = new Set<string>([...FEED_RESPONSE_WRITE_FIELDS, ...supplied]);
  return buildFromAllowlist(row, MEMORY_ATTRIBUTE_RULES, names);
}
