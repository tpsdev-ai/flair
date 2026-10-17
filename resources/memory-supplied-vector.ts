/**
 * Non-admin Memory writes discard caller-supplied vectors and model stamps.
 * Embedding is computed when the resulting write needs one. Vector-only PATCHes
 * and unchanged skill updates retain stored vectors. Non-admin skill updates
 * retain their stored stamps. Administrator and trusted in-process writes are
 * unchanged, as are `embedding: null` / `[]` handling and federation-sync records.
 */
import type { AgentAuthVerdict } from "./agent-auth.js";

/** True when `value` is a caller-supplied, non-empty embedding vector (an array,
 *  or a non-empty typed array). */
export function hasSuppliedVector(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) return value.byteLength > 0;
  return false;
}

/** True when the caller's object body supplies an `embeddingModel` stamp (any
 *  value, `null` included). Captured before a stored row is merged in, so a
 *  stamp carried from a stored row is never mistaken for one the caller set. */
export function suppliesEmbeddingModel(content: unknown): boolean {
  return !!content && typeof content === "object" && !Array.isArray(content) &&
    Object.prototype.hasOwnProperty.call(content, "embeddingModel");
}

/** True for a write that keeps the vector it carries: an administrator's write,
 *  or a trusted in-process write (no HTTP request) — operator reindex and import.
 *  For every other actor the vector is discarded, while the write itself may
 *  still succeed (an anonymous request never reaches a write). */
export function keepsSuppliedVector(auth: AgentAuthVerdict): boolean {
  return auth.kind === "internal" || (auth.kind === "agent" && auth.isAdmin);
}

/** Discard a non-admin write's caller-supplied vector and/or model stamp, in
 *  place. `suppliedVector` and `suppliedStamp` report what the CALLER's own body
 *  held before any stored row was merged in, so a vector prepareSkillBody carried
 *  from a stored row is left alone. A non-object or array body (no single record)
 *  is left untouched. Returns true when a caller-supplied value was discarded. */
export function discardSuppliedVector(
  content: Record<string, any> | null | undefined,
  auth: AgentAuthVerdict,
  supplied: { vector: boolean; stamp: boolean },
): boolean {
  if (!content || typeof content !== "object" || Array.isArray(content)) return false;
  if (keepsSuppliedVector(auth)) return false;
  const carriedVector = !supplied.vector && hasSuppliedVector(content.embedding);
  let discarded = false;
  if (supplied.vector && hasSuppliedVector(content.embedding)) {
    delete content.embedding;
    discarded = true;
  }
  if (supplied.stamp && !carriedVector) {
    delete content.embeddingModel;
    discarded = true;
  }
  return discarded;
}
