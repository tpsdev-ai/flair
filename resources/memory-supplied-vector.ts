/**
 * Non-admin Memory writes discard caller-supplied vectors and model stamps.
 * A vector or stamp counts as caller-supplied only when it differs from the
 * stored row's value; one re-sent unchanged is carried and kept as stored.
 * Embedding is computed when the resulting write needs one.
 * Administrator and trusted in-process writes and federation-sync records are unchanged.
 * Empty-vector normalization and the re-embed request protocol are unchanged;
 * an ordinary non-admin write strips a supplied stamp even alongside a null or empty embedding.
 */
import { isDeepStrictEqual } from "node:util";
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

function sameVector(a: unknown, b: unknown): boolean {
  const plain = (v: unknown) => (ArrayBuffer.isView(v) ? Array.from(v as unknown as ArrayLike<number>) : v);
  return isDeepStrictEqual(plain(a), plain(b));
}

/** What the caller's own body supplies: a non-null `embedding` and/or an
 *  `embeddingModel` that DIFFERS from the stored row's. With no stored row
 *  (a create) everything present is supplied. Captured before a stored row is
 *  merged into the body. */
export function suppliedVectorFlags(
  content: unknown,
  stored: Record<string, any> | null | undefined,
): { vector: boolean; stamp: boolean } {
  const body = content && typeof content === "object" && !Array.isArray(content) ? content as Record<string, any> : null;
  const vector = hasSuppliedEmbedding(body?.embedding) && !(stored && sameVector(body!.embedding, stored.embedding));
  const stamp = suppliesEmbeddingModel(content) && !(stored && isDeepStrictEqual(body!.embeddingModel, stored.embeddingModel));
  return { vector, stamp };
}

/** True for actors exempt from discarding caller-supplied vectors:
 *  administrators and trusted in-process callers. A stored vector carried by
 *  a non-admin skill update can remain. */
export function keepsSuppliedVector(auth: AgentAuthVerdict): boolean {
  return auth.kind === "internal" || (auth.kind === "agent" && auth.isAdmin);
}

/** Discard a non-admin write's caller-supplied vector and/or model stamp, in
 *  place. `supplied` comes from `suppliedVectorFlags`: what the CALLER's body
 *  held that differs from the stored row, before any stored row was merged in,
 *  so a vector prepareSkillBody carried from a stored row is left alone. A
 *  carried vector equal to `stored`'s keeps the stored stamp. A non-object or
 *  array body (no single record) is left untouched. Returns true when a field
 *  was removed. */
export function discardSuppliedVector(
  content: Record<string, any> | null | undefined,
  auth: AgentAuthVerdict,
  supplied: { vector: boolean; stamp: boolean },
  stored?: Record<string, any> | null,
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
  } else if (supplied.stamp && stored && sameVector(content.embedding, stored.embedding)) {
    if (Object.prototype.hasOwnProperty.call(stored, "embeddingModel")) content.embeddingModel = stored.embeddingModel;
    else delete content.embeddingModel;
    discarded = true;
  }
  return discarded;
}
