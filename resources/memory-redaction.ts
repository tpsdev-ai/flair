/**
 * memory-redaction.ts — server-side credential redaction for explicit Memory
 * writes (flair#2407).
 *
 * ONE redactor. This module calls the SAME `redactSecretsWithCount` the
 * automatic-capture path and the action-recall cache use
 * (packages/flair-mcp/src/secret-redaction.ts); the server imports it directly
 * rather than keeping a second pattern list, so the writers cannot drift.
 *
 * REDACTED_MEMORY_FIELDS lists the free-text fields redacted on a write:
 * `content` and `summary` (the two fields the content-safety scan treats as
 * prose — resources/content-safety.ts) plus a skill row's `trigger` (its "when
 * to use" text, which is embedded as the recall signal). Other declared fields
 * (id, agentId, tags, ...) are left as sent.
 *
 * The Memory resource's write paths (post/put/patch) and the feed ingest
 * (resources/MemoryFeed.ts) call redactMemoryWrite() on the write body of an
 * AGENT-authored write before the row is persisted, and — on post/put — before
 * the text-derived values (the dedup gate's input and the stored embedding) are
 * computed from it.
 *
 * Only agent-authored writes are redacted (isAgentAuthoredWrite): a write by a
 * verified, non-admin agent on its own behalf. Operator/admin and trusted
 * internal writes are left byte-faithful — the operator's shipped-skill seed,
 * for example, is verified by comparing the stored text to the source text, so
 * it must round-trip unchanged.
 *
 * NOT applied on the federation sync-in path: an inbound record is applied with
 * the RAW table handle (resources/Federation.ts) and may carry an origin
 * signature over its content; rewriting that content would stop the signature
 * verifying, so the server leaves it byte-for-byte as the origin wrote it.
 */

import { redactSecretsWithCount } from "../packages/flair-mcp/src/secret-redaction.js";

/** The free-text Memory fields redacted on a write. */
export const REDACTED_MEMORY_FIELDS = Object.freeze(["content", "summary", "trigger"] as const);

/**
 * Whether a write is agent-authored: a verified, non-admin agent writing on its
 * own behalf. Operator/admin (`isAdmin`) and trusted internal writes are not.
 */
export function isAgentAuthoredWrite(auth: { kind: string; isAdmin?: boolean }): boolean {
  return auth.kind === "agent" && auth.isAdmin !== true;
}

/**
 * Redact every free-text field of a Memory write body IN PLACE, returning the
 * number of credential values replaced (0 when nothing changed). A non-object
 * body is returned untouched.
 */
export function redactMemoryWrite(content: unknown): number {
  if (!content || typeof content !== "object" || Array.isArray(content)) return 0;
  const row = content as Record<string, unknown>;
  let count = 0;
  for (const field of REDACTED_MEMORY_FIELDS) {
    const value = row[field];
    if (typeof value !== "string") continue;
    const redacted = redactSecretsWithCount(value);
    if (redacted.count > 0) {
      row[field] = redacted.text;
      count += redacted.count;
    }
  }
  return count;
}
