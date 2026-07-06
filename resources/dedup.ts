// ─── Conservative near-duplicate detection primitives (Harper-free) ─────────
// Memory-integrity fix (#526/#548 field regressions). This module is
// deliberately Harper-free — same rationale as ./bm25.ts and ./scoring.ts —
// so the cosine+Jaccard co-gate math is unit-testable directly against the
// SHIPPED code without a live Harper. The DB-touching top-1-cosine lookup
// (needs `databases`) lives in ./Memory.ts, built on top of these primitives.
//
// ── THE INVARIANT ────────────────────────────────────────────────────────────
// This module NEVER decides whether to write. It only scores a candidate
// match. Callers (Memory.post / Memory.put) always write the new record; a
// "conservative match" is surfaced to the caller as a SIGNAL on the response
// (deduplicated/matchedId/matchConfidence), never as a reason to skip the
// write. That was the #526 bug: two topically-close but DISTINCT findings —
// one about replication route-directionality, one about DDL/schema
// replication — and the second was silently dropped because raw cosine alone
// flagged it as a "duplicate" of the first. Requiring BOTH cosine AND lexical
// (Jaccard token-overlap) to clear their thresholds against the SAME single
// top-cosine candidate catches true near-dups while sparing topic collisions
// (high cosine, low lexical) — and even then, only ever as a non-suppressing
// signal.
import { tokenize } from "./bm25.js";

/** Default raw-cosine similarity threshold for a candidate to even be considered. */
export const DEDUP_COSINE_THRESHOLD_DEFAULT = 0.95;

/** Default Jaccard token-overlap threshold (of the top cosine candidate). */
export const DEDUP_LEXICAL_THRESHOLD_DEFAULT = 0.5;

/** Below this content length, similarity scoring is unreliable ("ok" would
 *  match "ok" trivially) — the dedup gate is bypassed entirely. */
export const DEDUP_MIN_CONTENT_LENGTH = 20;

export interface DedupMatch {
  matchedId: string;
  cosine: number;
  lexical: number;
}

/**
 * Cosine similarity of two equal-length embedding vectors, computed directly
 * in JS. Used as a fallback for Harper's HNSW cosine-sort query omitting a
 * computed `$distance` on its top candidate when the query's post-filter
 * result set contains exactly ONE matching record (found in
 * resources/Memory.ts's findConservativeDedupMatch; the identical quirk is
 * also fixed in resources/SemanticSearch.ts's scoring loop for the same
 * reason). A mismatched length, empty vector, or
 * zero-magnitude side yields 0 (no signal, never treated as "identical" by a
 * degenerate computation).
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Jaccard similarity of two token sets: |A∩B| / |A∪B|. An empty side yields 0
 *  (no signal — never treated as "fully similar" by vacuous set equality). */
export function jaccardSimilarity(tokensA: string[], tokensB: string[]): number {
  const a = new Set(tokensA);
  const b = new Set(tokensB);
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Conservative match = cosine AND lexical BOTH clear their thresholds.
 * Both gates are required — a topic collision (high cosine, low lexical: two
 * DIFFERENT findings that merely share a topic/vocabulary) must NOT be
 * flagged as a duplicate. Only a true near-duplicate (high cosine AND high
 * lexical overlap) is flagged.
 */
export function isConservativeMatch(
  cosine: number,
  lexical: number,
  cosineThreshold: number = DEDUP_COSINE_THRESHOLD_DEFAULT,
  lexicalThreshold: number = DEDUP_LEXICAL_THRESHOLD_DEFAULT,
): boolean {
  return cosine >= cosineThreshold && lexical >= lexicalThreshold;
}

/** Compute the {cosine, lexical} confidence pair for a candidate against the
 *  new content's text, using the shared bm25 tokenizer. Rounded to 3dp to
 *  match the existing _score rounding convention (SemanticSearch.ts). */
export function computeMatchConfidence(
  newContent: string,
  candidateContent: string | undefined,
  cosine: number,
): { cosine: number; lexical: number } {
  const lexical = jaccardSimilarity(tokenize(newContent), tokenize(candidateContent || ""));
  return {
    cosine: Math.round(cosine * 1000) / 1000,
    lexical: Math.round(lexical * 1000) / 1000,
  };
}
