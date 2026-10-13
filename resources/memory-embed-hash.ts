/**
 * memory-embed-hash.ts — the binding between a Memory row's stored vector and
 * the text it was computed from (flair#2465, part 2).
 *
 * A row's embedding is only meaningful for the text it was embedded from. This
 * module defines that text's hash with the SAME function that defines a Memory
 * row's `contentHash` (`memory-feed-lib.ts`'s `computeContentHash`), applied to
 * the field the row actually embeds from (`skill-write.ts`'s `skillEmbedText`:
 * `trigger` for a skill-tagged row with a non-empty trigger, else `content`).
 *
 * The server records this hash as `embeddedContentHash` when it computes a
 * vector on a guarded path: an ordinary Memory POST/PUT/PATCH embed, the
 * re-embed PATCH, the stamp migration's `.content`-suffix fallback and the
 * auto-embed backfill. A caller-supplied vector gets no new hash (a create
 * stores none; an update keeps the stored one). The embedding-stamp migration
 * treats an embedding as current when its `embeddingModel` is current-space AND
 * either no hash is recorded or the recorded hash equals the hash of the row's
 * CURRENT embedding text. A recorded hash left behind by a text edit therefore
 * re-queues the row; a missing hash does not.
 *
 * Deliberately a plain function: importing `memory-feed-lib.js` /
 * `skill-write.js` (both Harper-free) keeps this usable from a migration's unit
 * test with no live runtime.
 */
import { computeContentHash } from "./memory-feed-lib.js";
import { skillEmbedText } from "./skill-write.js";

/**
 * The content hash of `text` embedded for a row owned by `agentId`.
 * `undefined` when there is no owning agent or no text — there is nothing to
 * bind a vector to.
 */
export function hashEmbeddedText(agentId: unknown, text: unknown): string | undefined {
  if (typeof agentId !== "string" || agentId.length === 0) return undefined;
  if (typeof text !== "string" || text.length === 0) return undefined;
  return computeContentHash(agentId, text);
}

/**
 * The content hash of the text a row's embedding is (or should be) computed
 * from: {@link hashEmbeddedText} of the row's owner and `skillEmbedText(row)`.
 */
export function embeddedTextHash(row: Record<string, any> | null | undefined): string | undefined {
  if (!row || typeof row !== "object") return undefined;
  return hashEmbeddedText(row.agentId, skillEmbedText(row));
}

/**
 * The hash half of "is a row's stored embedding current?" (the caller applies
 * the `embeddingModel` half, `isCurrentSpaceStamp`). True when the row records
 * no `embeddedContentHash`, or the recorded hash equals the hash of the row's
 * current embedding text.
 *
 * A row records no hash when it was written before this field existed, created
 * with a caller-supplied vector, written by a path that records none, or has no
 * owner or no text to hash. Such a row is TRUSTED here (treated as
 * current); a later server-computed embed records a hash for it. See the
 * migration's module doc for the cost of re-queueing these rows instead.
 */
export function embeddedHashMatches(row: Record<string, any> | null | undefined): boolean {
  const recorded = row?.embeddedContentHash;
  if (recorded === undefined || recorded === null) return true; // no recorded hash — trusted
  const expected = embeddedTextHash(row);
  return typeof expected === "string" && recorded === expected;
}
