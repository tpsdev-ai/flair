/**
 * memory-redaction.ts — server-side credential redaction for explicit Memory
 * writes (flair#2407).
 *
 * ONE redactor. The automatic-capture path and the action-recall cache call
 * `redactSecrets` (packages/flair-mcp/src/secret-redaction.ts), which delegates
 * to `redactSecretsWithCount`; this module calls `redactSecretsWithCount`
 * directly, so the server keeps no second pattern list.
 *
 * REDACTED_MEMORY_FIELDS names the three fields redacted on a write: `content`,
 * `summary` and `trigger`. Other fields (id, agentId, tags, metadata, ...) are
 * not redacted.
 *
 * Memory post/put/patch and the feed ingest (resources/MemoryFeed.ts) call
 * redactMemoryWrite() on the write body before the row is persisted; post and
 * put call it before the dedup gate and the stored embedding are computed.
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
import { skillWriteSource } from "./skill-write-policy.js";

/** The Memory fields redacted on a write. */
export const REDACTED_MEMORY_FIELDS = Object.freeze(["content", "summary", "trigger"] as const);

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

/** The redacted fields a stored embedding is computed from (resources/skill-write.ts, skillEmbedText). */
const EMBEDDING_SOURCE_FIELDS: ReadonlySet<string> = new Set(["content", "trigger"]);

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
