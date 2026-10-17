/**
 * Non-admin Memory writes discard caller-supplied vectors and model stamps.
 * Embedding is computed when the resulting write needs one.
 * Administrator and trusted in-process writes and federation-sync records are unchanged.
 * Empty-vector normalization and the re-embed request protocol are unchanged;
 * an ordinary non-admin write strips a supplied stamp even alongside a null or empty embedding.
 */
import type { AgentAuthVerdict } from "./agent-auth.js";

/** Presence check after empty-embedding normalization, not vector validation. */
export function hasSuppliedEmbedding(value: unknown): boolean {
  return value !== null && value !== undefined;
}

/** True when the caller's object body supplies an `embeddingModel` stamp (any
 *  value, `null` included). Captured before a stored row is merged in, so a
 *  stamp carried from a stored row is never mistaken for one the caller set. */
export function suppliesEmbeddingModel(content: unknown): boolean {
  return !!content && typeof content === "object" && !Array.isArray(content) &&
    Object.prototype.hasOwnProperty.call(content, "embeddingModel");
}

/** True for actors exempt from discarding caller-supplied vectors:
 *  administrators and trusted in-process callers. A stored vector carried by
 *  a non-admin skill update can remain. */
export function keepsSuppliedVector(auth: AgentAuthVerdict): boolean {
  return auth.kind === "internal" || (auth.kind === "agent" && auth.isAdmin);
}

/** Discard a non-admin write's caller-supplied vector and/or model stamp, in
 *  place. `suppliedVector` and `suppliedStamp` report what the CALLER's own body
 *  held before any stored row was merged in, so a vector prepareSkillBody carried
 *  from a stored row is left alone. A non-object or array body (no single record)
 *  is left untouched. Returns true when a field was removed. */
export function discardSuppliedVector(
  content: Record<string, any> | null | undefined,
  auth: AgentAuthVerdict,
  supplied: { vector: boolean; stamp: boolean },
): boolean {
  if (!content || typeof content !== "object" || Array.isArray(content)) return false;
  if (keepsSuppliedVector(auth)) return false;
  const carriedVector = !supplied.vector && hasSuppliedEmbedding(content.embedding);
  let discarded = false;
  if (supplied.vector && hasSuppliedEmbedding(content.embedding)) {
    discarded = Object.prototype.hasOwnProperty.call(content, "embedding");
    delete content.embedding;
  }
  if ((supplied.vector || supplied.stamp) && !carriedVector) {
    discarded = Object.prototype.hasOwnProperty.call(content, "embeddingModel") || discarded;
    delete content.embeddingModel;
  }
  return discarded;
}
