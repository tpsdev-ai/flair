/**
 * memory-embed-hash.ts — the text hash the server stores with a vector it
 * computes, and the expected hash a stored value is compared with (flair#2465,
 * part 2).
 *
 * A row's embedding is only meaningful for the text it was embedded from. This
 * module defines that text's hash with the SAME function that defines a Memory
 * row's `contentHash` (`memory-feed-lib.ts`'s `computeContentHash`), applied to
 * the field the row actually embeds from (`skill-write.ts`'s `skillEmbedText`:
 * `trigger` for a skill-tagged row with a non-empty trigger, else `content`).
 *
 * Three values are kept apart:
 *   - the EXPECTED hash of a row's current text ({@link embeddedTextHash});
 *   - a NEWLY COMPUTED hash: the expected hash the server stores as
 *     `embeddedContentHash` when it computes a vector on a guarded path (an
 *     ordinary Memory POST/PUT/PATCH embed, the re-embed PATCH, the stamp
 *     migration's `.content`-suffix fallback, the auto-embed backfill);
 *   - a RETAINED hash: a preserved stored value that a write keeps without
 *     computing a vector (a PUT or PATCH that carries a vector or stores one
 *     accepted from the caller, a skill successor that carries the stored
 *     vector). It may describe an
 *     earlier server-computed vector, not necessarily the vector stored now.
 *     A value received through federation is an unverified peer assertion.
 * Exceptions: a row with an empty owner gets no hash (null) even from a
 * server-computed embed, and a vector accepted and stored from the caller gets
 * no newly computed hash (a POST or PUT create stores null; an admin PATCH
 * create drops a submitted value and can leave the field absent; an update
 * retains the stored hash beside it). When redaction changes the text, the
 * supplied vector is discarded instead, and the write embeds the redacted text
 * and stores a newly computed hash when the engine returns a vector.
 *
 * The embedding-stamp migration treats an embedding as current when its
 * `embeddingModel` is current-space AND the stored hash is absent or equals the
 * expected hash. A stored hash that differs from the expected hash re-queues
 * the row; an absent hash does not.
 *
 * Deliberately a plain function: importing `memory-feed-lib.js` /
 * `skill-write.js` (both Harper-free) keeps this usable from a migration's unit
 * test with no live runtime.
 */
import { computeContentHash } from "./memory-feed-lib.js";
import { skillEmbedText } from "./skill-write.js";

/**
 * `computeContentHash(agentId, text)`. Requires a non-empty string `agentId`
 * (the row's owner) and non-empty `text`; otherwise `undefined`, and a writer
 * stores null.
 */
export function hashEmbeddedText(agentId: unknown, text: unknown): string | undefined {
  if (typeof agentId !== "string" || agentId.length === 0) return undefined;
  if (typeof text !== "string" || text.length === 0) return undefined;
  return computeContentHash(agentId, text);
}

/**
 * The EXPECTED hash of a row's current embedding text: {@link hashEmbeddedText}
 * of the row's owner and `skillEmbedText(row)`.
 */
export function embeddedTextHash(row: Record<string, any> | null | undefined): string | undefined {
  if (!row || typeof row !== "object") return undefined;
  return hashEmbeddedText(row.agentId, skillEmbedText(row));
}

/**
 * The hash half of "is a row's stored embedding current?" (the caller applies
 * the `embeddingModel` half, `isCurrentSpaceStamp`). True when the row stores
 * no `embeddedContentHash`, or the stored hash equals the expected hash of the
 * row's current embedding text.
 *
 * Only an actually absent hash (null or undefined) bypasses the comparison
 * here; a matching hash passes it. Either way the caller still requires a
 * current-space model. A row can lack a hash because it was written before
 * this field existed, was created through POST or PUT with a vector accepted
 * from the caller or through an admin PATCH create, or was written by a path
 * that stores none; a server-computed embed stores none for a row with an
 * empty owner or no text. A row with an empty owner or no text can still hold
 * a retained or federation-received hash: that value is compared like any
 * other and, with no expected hash to equal, fails the comparison. See the
 * migration's module doc for the cost of re-queueing rows with no hash
 * instead.
 */
export function embeddedHashMatches(row: Record<string, any> | null | undefined): boolean {
  const recorded = row?.embeddedContentHash;
  if (recorded === undefined || recorded === null) return true; // no stored hash — comparison bypassed
  const expected = embeddedTextHash(row);
  return typeof expected === "string" && recorded === expected;
}

/**
 * The vector one write attempt staged and the text it was computed from, kept
 * by a writer whose committed row that attempt could not confirm, so its retry
 * can check whether the row still holds that vector (flair#2478).
 */
export interface StagedVector {
  embedding: readonly number[];
  text: string;
}

/** Element-wise tolerance for {@link holdsOwnStaleVector}: wide enough for a
 *  float32 round-trip of a stored value. */
const STAGED_VECTOR_TOLERANCE = 1e-6;

/**
 * True when the row's stored vector matches `staged.embedding` element by
 * element within {@link STAGED_VECTOR_TOLERANCE} while the row's current
 * embedding text (`skillEmbedText`) is not `staged.text`. A match means the row
 * holds a vector equal, within that tolerance, to the one this writer computed
 * for `staged.text`, a text the row no longer has, so the caller re-embeds the
 * current text. It is evidence that the stored vector matches this writer's
 * computation, not proof of which writer stored it, and it assumes nothing
 * about how far apart the vectors of different texts are. The stored
 * `embeddedContentHash` is not consulted: it is null for a row with an empty
 * owner and so would match any text. Returns false when nothing was staged,
 * when the row's text is still `staged.text`, or when the stored vector does
 * not match (its provenance is then unknown, and the caller leaves it as it is).
 */
export function holdsOwnStaleVector(row: Record<string, any> | null | undefined, staged: StagedVector | undefined): boolean {
  if (!staged || !row || typeof row !== "object") return false;
  if (skillEmbedText(row) === staged.text) return false;
  const stored = row.embedding as ArrayLike<unknown> | null | undefined;
  if (stored == null || typeof stored.length !== "number" || stored.length !== staged.embedding.length) return false;
  for (let i = 0; i < staged.embedding.length; i++) {
    const value = stored[i];
    if (typeof value !== "number" || !(Math.abs(value - staged.embedding[i]) <= STAGED_VECTOR_TOLERANCE)) return false;
  }
  return true;
}
