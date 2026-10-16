/**
 * memory-redaction.ts — server-side credential redaction for explicit Memory
 * writes (flair#2407).
 *
 * ONE redactor. The automatic-capture path and the action-recall cache call
 * `redactSecrets` (packages/flair-mcp/src/secret-redaction.ts), which delegates
 * to `redactSecretsWithCount`; this module calls `redactSecretsWithCount`
 * directly, so the server keeps no second pattern list.
 *
 * Memory text fields are redacted on write. Skill writes refuse metadata with
 * duplicate top-level keys; otherwise name/description and string tags are
 * redacted (flair#2575).
 *
 * Memory post/put/patch and the feed ingest (resources/MemoryFeed.ts) call
 * redactMemoryWrite() on the write body before the row is persisted; post and
 * put call it before the dedup gate and the stored embedding are computed.
 * post, put and the feed ingest call redactSkillWrite() on the EFFECTIVE row
 * after skill-tag inheritance (prepareSkillBody) and before persistence, so an
 * omitted-tag PUT on a stored skill, a superseding POST and a feed ingest
 * redact the skill fields of the row they write.
 * When the count is above zero, a Memory post/put/patch response also carries
 * `stored`: the stored (post-redaction) values of the fields that write's
 * request supplied (flair#2561) — the REDACTED_MEMORY_FIELDS it supplied as
 * strings (suppliedMemoryTextFields) and, for a skill-tagged row, the skill
 * fields it supplied (suppliedSkillTextFields, flair#2575). The supplied
 * fields are read from the body as the request sent it, before a stored row or
 * a skill predecessor is merged into it (suppliedStoredTextFields,
 * storedMemoryText). The feed ingest's response holds, of the row it stored or
 * matched, only named primitive fields, plus `redactedValues` when present
 * (resources/memory-write-response.ts).
 * A skill PUT whose redaction replaced a value always writes its redacted
 * effective row, so each field `stored` reports is what the row holds: the
 * in-place (reserved seed) PUT's unchanged-row check never skips it.
 * put() skips the call for the shipped-skill seed write (isOperatorSeedPut): a
 * PUT of the reserved seed skill id by a verified Basic administrator
 * (src/lib/skill-seed.ts). The seed compares the stored text to its source
 * text, so it must round-trip unchanged. The call does not otherwise depend on
 * the caller: an admin Ed25519 key or an OAuth principal is an agent
 * (resources/skill-write-policy.ts) and is redacted. put()'s `_reindex` re-PUT
 * returns before the call; it refuses a change to these fields.
 *
 * The FederationSync receive path does not call this module: the redactor
 * leaves incoming federated content alone. Federation checks a record's
 * signature, when it carries one, on the incoming record before it adds
 * receiver bookkeeping to the row.
 */

import { redactSecretsWithCount } from "../packages/flair-mcp/src/secret-redaction.js";
import type { AgentAuthVerdict } from "./agent-auth.js";
import { isReservedSeedId } from "./seed-reservation.js";
import { isSkillWrite, MEMORY_EMBEDDING_INPUT_FIELDS } from "./skill-write.js";
import { parseSkillMetadata } from "./skill-provenance.js";
import { skillWriteSource } from "./skill-write-policy.js";

/** The Memory text fields redacted on a write. */
export const REDACTED_MEMORY_FIELDS = Object.freeze(["content", "summary", "trigger"] as const);

/** One of the REDACTED_MEMORY_FIELDS. */
export type MemoryTextField = (typeof REDACTED_MEMORY_FIELDS)[number];

/** Metadata fields selected after duplicate-key validation. */
export const REDACTED_SKILL_FIELDS = Object.freeze(["name", "description"] as const);

/** A skill field a write's `stored` can report (flair#2575): one of the
 *  REDACTED_SKILL_FIELDS (a `metadata` key) or `tags`. */
export type SkillTextField = (typeof REDACTED_SKILL_FIELDS)[number] | "tags";

/** A field a write's `stored` can report: a MemoryTextField or a SkillTextField. */
export type StoredTextField = MemoryTextField | SkillTextField;

/** The redacted skill fields of one skill-tagged row, as a write's response
 *  reports them: the `metadata` keys plus the accepted `tags` entries (the
 *  schema declares `[String]`, so an entry is a string or null). */
export interface StoredSkillText {
  name?: string;
  description?: string;
  tags?: (string | null)[];
}

/** The redacted fields of one row, as a write's response reports them: the
 *  REDACTED_MEMORY_FIELDS that hold a string, plus the skill fields when the row
 *  is skill-tagged (StoredSkillText), each only when the request supplied it. */
export type StoredMemoryText =
  & Partial<Record<MemoryTextField, string>>
  & StoredSkillText;

/**
 * flair#2561: the string-valued text fields a write request supplies: each of
 * the REDACTED_MEMORY_FIELDS that holds a string in the request body. A field
 * the body sends as null or as a non-string is not in the list. A write reads
 * them from the body as the request sent it, before a stored row or a skill
 * predecessor is merged into that body, so the list names only text fields the
 * request itself carried.
 */
export function suppliedMemoryTextFields(body: unknown): MemoryTextField[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  return REDACTED_MEMORY_FIELDS.filter((field) => typeof (body as Record<string, unknown>)[field] === "string");
}

/**
 * flair#2561, flair#2575: the skill fields a write request supplies: `name` and
 * `description` when the body's own `metadata` holds a string under that key,
 * and `tags` when the body carries a `tags` array. Read, like
 * suppliedMemoryTextFields, from the body as the request sent it, before a
 * stored row or a skill predecessor is merged into it, so a field the row
 * inherits (an omitted `tags` array, or a predecessor's `metadata`) is not in
 * the list.
 */
export function suppliedSkillTextFields(body: unknown): SkillTextField[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  const record = body as Record<string, unknown>;
  const meta = parseSkillMetadata(record.metadata);
  const supplied: SkillTextField[] = REDACTED_SKILL_FIELDS.filter((field) => typeof meta[field] === "string");
  if (Array.isArray(record.tags)) supplied.push("tags");
  return supplied;
}

/** The fields a Memory POST or PUT request supplies that its `stored` can
 *  report: suppliedMemoryTextFields plus suppliedSkillTextFields. */
export function suppliedStoredTextFields(body: unknown): StoredTextField[] {
  return [...suppliedMemoryTextFields(body), ...suppliedSkillTextFields(body)];
}

/**
 * flair#2467, flair#2561, flair#2575: the values on `row` of the `supplied`
 * fields, copied; a supplied field that holds no value on `row` is left out. A
 * write calls it on the row it stages, after redaction, with the fields its own
 * request supplied (suppliedMemoryTextFields, suppliedStoredTextFields), so the
 * copy holds the stored (post-redaction) value of each of those fields, changed
 * or not, and no other field of the row: a field the row holds from a merged
 * stored row or a skill predecessor is not in it. For a skill-tagged row the
 * supplied skill fields are the `metadata` `name`/`description` (parsed out of
 * the row) and the accepted `tags` entries. When the write replaced any value,
 * its response carries the copy as `stored` next to `redactedValues`; the
 * writer never has to read the row back, so a later write cannot change what
 * this one reports.
 */
export function storedMemoryText(row: unknown, supplied: readonly StoredTextField[]): StoredMemoryText {
  const stored: StoredMemoryText = {};
  if (!row || typeof row !== "object" || Array.isArray(row)) return stored;
  const record = row as Record<string, unknown>;
  for (const field of REDACTED_MEMORY_FIELDS) {
    if (!supplied.includes(field)) continue;
    const value = record[field];
    if (typeof value === "string") stored[field] = value;
  }
  if (isSkillWrite(record)) {
    const meta = parseSkillMetadata(record.metadata);
    for (const field of REDACTED_SKILL_FIELDS) {
      if (supplied.includes(field) && typeof meta[field] === "string") stored[field] = meta[field] as string;
    }
    // Report the entries the schema accepts (`[String]`: a string or null), so
    // `stored.tags` is what the row carries, not only its string entries.
    if (supplied.includes("tags") && Array.isArray(record.tags)) {
      stored.tags = record.tags.filter((tag): tag is string | null => typeof tag === "string" || tag === null);
    }
  }
  return stored;
}

/**
 * Whether a Memory PUT is the shipped-skill seed write: the caller is a
 * verified Basic administrator (skillWriteSource "operator") and every id the
 * write names (the URL id and any body id) is the reserved seed skill id.
 */
export function isOperatorSeedPut(context: unknown, auth: AgentAuthVerdict, ids: unknown[]): boolean {
  const named = ids.filter((id) => id !== undefined && id !== null);
  if (named.length === 0 || !named.every((id) => isReservedSeedId("Memory", id))) return false;
  return skillWriteSource(context, auth) === "operator";
}

export interface MemoryWriteRedaction {
  /** Credential values replaced (0 when the body is unchanged). */
  count: number;
  /** True when a caller-supplied `embedding`/`embeddingModel` was removed. */
  embeddingDiscarded: boolean;
}

/** The redacted fields an embedding can be computed from, across row kinds:
 *  `trigger` for a skill-tagged row with a non-empty trigger, `content` for every
 *  other row (MEMORY_EMBEDDING_INPUT_FIELDS, next to embedTextField/skillEmbedText
 *  in resources/skill-write.ts). Redaction sees the write body, not the stored
 *  row's kind, so it uses the whole set. */
const EMBEDDING_SOURCE_FIELDS: ReadonlySet<string> = new Set(MEMORY_EMBEDDING_INPUT_FIELDS);

/**
 * Redact REDACTED_MEMORY_FIELDS of a write body IN PLACE. When the redaction
 * changes `content` or `trigger`, the fields an embedding is computed from, a
 * caller-supplied `embedding` and `embeddingModel` are removed from the body,
 * so the supplied vector is not stored. For a non-object input it changes
 * nothing and returns `{ count: 0, embeddingDiscarded: false }`.
 */
export function redactMemoryWrite(content: unknown): MemoryWriteRedaction {
  const none = { count: 0, embeddingDiscarded: false };
  if (!content || typeof content !== "object" || Array.isArray(content)) return none;
  const row = content as Record<string, unknown>;
  let count = 0;
  let embedSourceChanged = false;
  for (const field of REDACTED_MEMORY_FIELDS) {
    const value = row[field];
    if (typeof value !== "string") continue;
    const redacted = redactSecretsWithCount(value);
    if (redacted.text !== value) {
      row[field] = redacted.text;
      count += redacted.count;
      if (EMBEDDING_SOURCE_FIELDS.has(field)) embedSourceChanged = true;
    }
  }
  if (count === 0) return none;
  const supplied = row.embedding != null || row.embeddingModel != null;
  if (!supplied || !embedSourceChanged) return { count, embeddingDiscarded: false };
  delete row.embedding;
  delete row.embeddingModel;
  return { count, embeddingDiscarded: true };
}

/**
 * Redact name/description and string tags after prepareSkillBody has refused
 * metadata with duplicate top-level keys and resolved the effective skill tag.
 * Returns the number of values replaced.
 */
export function redactSkillWrite(row: unknown): number {
  if (!row || typeof row !== "object" || Array.isArray(row)) return 0;
  const record = row as Record<string, unknown>;
  return isSkillWrite(record) ? redactSkillFields(record) : 0;
}

/** Redact validated skill fields in place. */
function redactSkillFields(row: Record<string, unknown>): number {
  let count = 0;
  if (Array.isArray(row.tags)) {
    row.tags = row.tags.map((entry) => {
      if (typeof entry !== "string") return entry;
      const redacted = redactSecretsWithCount(entry);
      if (redacted.text === entry) return entry;
      count += redacted.count;
      return redacted.text;
    });
  }
  count += redactSkillMetadata(row);
  return count;
}

/** Serialize validated metadata only when name or description changes. */
function redactSkillMetadata(row: Record<string, unknown>): number {
  const original = row.metadata;
  const asString = typeof original === "string";
  const asObject = original !== null && typeof original === "object" && !Array.isArray(original);
  if (!asString && !asObject) return 0;
  const parsed = parseSkillMetadata(original);
  let count = 0;
  for (const field of REDACTED_SKILL_FIELDS) {
    const value = parsed[field];
    if (typeof value !== "string") continue;
    const redacted = redactSecretsWithCount(value);
    if (redacted.text !== value) {
      parsed[field] = redacted.text;
      count += redacted.count;
    }
  }
  if (count === 0) return 0;
  row.metadata = asString ? JSON.stringify(parsed) : parsed;
  return count;
}
