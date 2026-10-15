/** Successful write replies with a body read named fields by type; no embedding field whatever storage returns. */

export const MEMORY_EMBEDDING_FIELDS = Object.freeze(["embedding", "embeddingModel"] as const);

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

export function suppliedMemoryFields(body: unknown): ReadonlySet<string> {
  if (!isPlainRecord(body)) return new Set();
  return new Set(Object.keys(body).filter((key) => body[key] !== undefined && body[key] !== null));
}

export const WRITE_RESPONSE_WITHHELD = "write_response_withheld";

export const WRITE_RESPONSE_WITHHELD_MESSAGE =
  "the server does not report this write's result; read the row to see what is stored";

export function withheldWriteResult(): Response {
  return Response.json({ error: WRITE_RESPONSE_WITHHELD, message: WRITE_RESPONSE_WITHHELD_MESSAGE }, { status: 500 });
}

export function storageResult<T>(value: T): T | Response {
  return value instanceof Response ? withheldWriteResult() : value;
}

export function writeResultResponse(response: Response): Response {
  if (!response.ok) return response;
  return withheldWriteResult();
}

export type FieldRule =
  | { readonly type: "string" | "integer" | "number" | "boolean"; readonly nullable?: boolean; readonly required?: boolean }
  | { readonly type: "object"; readonly fields: FieldRules; readonly required?: boolean };

export type FieldRules = Readonly<Record<string, FieldRule>>;

const SKIP: unique symbol = Symbol("skip");

function namedField(source: unknown, name: string): unknown {
  if (source === null || (typeof source !== "object" && typeof source !== "function")) return undefined;
  try {
    return (source as Record<string, unknown>)[name];
  } catch {
    return undefined;
  }
}

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
    case "object": {
      if (!isPlainRecord(value)) return SKIP;
      const built = buildFromAllowlist(value, rule.fields);
      return built instanceof Response ? SKIP : built;
    }
  }
}

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
    Object.defineProperty(built, name, { value: typed, enumerable: true, writable: true, configurable: true });
  }
  return built;
}

const STRING: FieldRule = Object.freeze({ type: "string", nullable: true });
const INTEGER: FieldRule = Object.freeze({ type: "integer", nullable: true });
const BOOLEAN: FieldRule = Object.freeze({ type: "boolean", nullable: true });

export const FEED_FIELD_RULES: FieldRules = Object.freeze({
  id: Object.freeze({ type: "string", required: true }),
  agentId: STRING, content: STRING, contentHash: STRING, trigger: STRING, visibility: STRING,
  durability: STRING, source: STRING, type: STRING, createdAt: STRING, updatedAt: STRING,
  instanceToken: STRING, expiresAt: STRING, retrievalCount: INTEGER, lastRetrieved: STRING, usageCount: INTEGER,
  promotionStatus: STRING, promotedAt: STRING, promotedBy: STRING, archived: BOOLEAN, archivedAt: STRING,
  archivedBy: STRING, parentId: STRING, sessionId: STRING, lastReflected: STRING,
  supersedes: STRING, subject: STRING, summary: STRING, validFrom: STRING, validTo: STRING,
  provenance: STRING, originatorInstanceId: STRING, metadata: STRING, skillSubjectId: STRING,
  kind: STRING, _originatorInstanceId: STRING, _syncedFrom: STRING, _syncedAt: STRING,
  written: Object.freeze({ type: "boolean" }),
});

export const STORED_TEXT_RULES: FieldRules = Object.freeze({
  content: Object.freeze({ type: "string" }),
  summary: Object.freeze({ type: "string" }),
  trigger: Object.freeze({ type: "string" }),
});

export const REDACTION_RULES: FieldRules = Object.freeze({
  redactedValues: Object.freeze({ type: "integer" }),
  stored: Object.freeze({ type: "object", fields: STORED_TEXT_RULES }),
});

export function feedResponseFields(row: unknown, supplied: ReadonlySet<string>): Record<string, unknown> | Response {
  if (row instanceof Response) return withheldWriteResult();
  const names = new Set<string>([...FEED_RESPONSE_WRITE_FIELDS, ...supplied]);
  return buildFromAllowlist(row, FEED_FIELD_RULES, names);
}
