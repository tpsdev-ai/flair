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
 * A writer that stores a vector records this hash as `embeddedContentHash`.
 * The embedding-stamp migration then treats an embedding as current only when
 * its `embeddingModel` is current-space AND its recorded hash still equals the
 * hash of the row's CURRENT embedding text — so a vector left behind by a text
 * edit is re-queued rather than trusted.
 *
 * Deliberately a plain function: importing `memory-feed-lib.js` /
 * `skill-write.js` (both Harper-free) keeps this usable from a migration's unit
 * test with no live runtime.
 */
import { computeContentHash } from "./memory-feed-lib.js";
import { skillEmbedText } from "./skill-write.js";

/**
 * The content hash of the text a row's embedding is (or should be) computed
 * from. `undefined` when the row has no embedding text or no owning agent —
 * there is nothing to bind a vector to.
 */
export function embeddedTextHash(row: Record<string, any> | null | undefined): string | undefined {
  if (!row || typeof row !== "object") return undefined;
  const agentId = row.agentId;
  if (typeof agentId !== "string" || agentId.length === 0) return undefined;
  const text = skillEmbedText(row);
  if (typeof text !== "string" || text.length === 0) return undefined;
  return computeContentHash(agentId, text);
}

/**
 * Is a row's stored embedding current? Current means both:
 *   - `embeddingModel` is a current-space stamp for `currentModelId`
 *     (`isCurrentSpaceStamp`, applied by the caller), AND
 *   - the recorded `embeddedContentHash` still equals the hash of the row's
 *     current embedding text.
 *
 * A row with NO recorded `embeddedContentHash` is a legacy row: it carries no
 * binding, so it is TRUSTED here (treated as current) and left for the next text
 * edit, which stamps a fresh hash — see the migration's module doc for the cost
 * comparison against re-queueing legacy rows.
 */
export function embeddedHashMatches(row: Record<string, any> | null | undefined): boolean {
  const recorded = row?.embeddedContentHash;
  if (recorded === undefined || recorded === null) return true; // legacy row — trusted
  const expected = embeddedTextHash(row);
  return typeof expected === "string" && recorded === expected;
}
