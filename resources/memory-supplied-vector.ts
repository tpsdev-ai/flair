/**
 * flair#2573 slice 2 — an agent's Memory write never stores a vector the caller
 * supplied.
 *
 * The configured model is the ONLY source of a stored Memory vector's space: a
 * supplied vector cannot be verified against the text it claims to embed or
 * against the model, so the embedding-space guard can never trust it. A non-admin
 * POST, PUT or PATCH that carries a non-empty `embedding` therefore discards the
 * vector and its `embeddingModel` stamp before the write; the write then embeds
 * the row's own post-redaction text with the current model, stamped, exactly as a
 * write that sent no vector. When the model is unavailable the row stores no
 * vector and the auto-embed backfill embeds it later.
 *
 * Unchanged: `embedding: null` and `[]` (the empty-embedding normalization from
 * #2593), the re-embed request protocol, an administrator's write, a trusted
 * in-process write, and a record arriving by federation sync (those write through
 * the raw table handle, never these methods).
 */
import type { AgentAuthVerdict } from "./agent-auth.js";

/** True when `value` is a caller-supplied, non-empty embedding vector (an array,
 *  or a non-empty typed array). */
export function hasSuppliedVector(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) return value.byteLength > 0;
  return false;
}

/** True for a write that keeps the vector it carries: an administrator's write,
 *  or a trusted in-process write (no HTTP request) — operator reindex and import.
 *  Every other actor is refused a supplied vector (an anonymous request never
 *  reaches a write). */
export function keepsSuppliedVector(auth: AgentAuthVerdict): boolean {
  return auth.kind === "internal" || (auth.kind === "agent" && auth.isAdmin);
}

/** Discard a non-admin write's supplied vector and its model stamp, in place.
 *  Returns true when a vector was discarded. A non-object or array body (no
 *  single record) is left untouched. */
export function discardSuppliedVector(content: Record<string, any> | null | undefined, auth: AgentAuthVerdict): boolean {
  if (!content || typeof content !== "object" || Array.isArray(content)) return false;
  if (keepsSuppliedVector(auth)) return false;
  if (!hasSuppliedVector(content.embedding)) return false;
  delete content.embedding;
  delete content.embeddingModel;
  return true;
}
