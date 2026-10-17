/**
 * flair#2573 slice 2 — a non-admin Memory write never stores a vector the caller
 * supplied.
 *
 * The space of a Memory vector is defined by the model that computed it. A
 * supplied vector cannot be verified against the text it claims to embed or
 * against the model, so a non-admin write discards it and stores the vector the
 * configured model computes instead. A non-admin POST, PUT or PATCH that carries
 * a non-empty `embedding` therefore discards the
 * vector and its `embeddingModel` stamp before the write, so the write stores the
 * vector the server computes for the row's own post-redaction text, or none when
 * the model is unavailable (the auto-embed backfill embeds it later) — exactly as
 * a write that sent no vector.
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
