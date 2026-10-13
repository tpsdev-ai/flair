/**
 * memory-embed-hash.ts — the hash of the text a Memory row's vector was
 * computed from (flair#2465, part 2).
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
 *   - a RETAINED hash: a stored value a write keeps without computing a vector
 *     (a PUT or PATCH that carries or supplies a vector, a Feed skill successor
 *     that carries the stored vector), or a federation peer's value. It records
 *     the text an earlier vector was computed from, not necessarily the vector
 *     stored now.
 * Exceptions: a row with an empty owner gets no hash (null) even from a
 * server-computed embed, and a caller-supplied vector gets no newly computed
 * hash (a create stores null; an update retains the stored hash beside it).
 *
 * The embedding-stamp migration treats an embedding as current when its
 * `embeddingModel` is current-space AND the stored hash is absent or equals the
 * expected hash. A stored hash that differs from the expected hash (the text
 * changed after that vector was computed) re-queues the row; an absent hash
 * does not.
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
 * A row stores no hash when it was written before this field existed, was
 * created with a caller-supplied vector, was written by a path that stores
 * none, or has an empty owner or no text. Such a row is TRUSTED here (treated
 * as current). A server-computed embed stores a hash for it only when the row
 * has a non-empty owner and text. See the migration's module doc for the cost
 * of re-queueing these rows instead.
 */
export function embeddedHashMatches(row: Record<string, any> | null | undefined): boolean {
  const recorded = row?.embeddedContentHash;
  if (recorded === undefined || recorded === null) return true; // no stored hash — trusted
  const expected = embeddedTextHash(row);
  return typeof expected === "string" && recorded === expected;
}
