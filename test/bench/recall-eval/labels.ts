/**
 * labels.ts — Layer 1 deterministic recall eval: the curated corpus binding,
 * the FIXED relevance labels, the floors, and the self-pollution control.
 *
 * This is the #17 fix's ground truth. The old recall QUALITY signal — the
 * `flair quality` recall SPOT-CHECK (src/cli.ts `deriveRecallCue` +
 * `computeRecallSpotCheck`) — derives its "query" from a memory's OWN text (a
 * sliding partial cue) and calls recall a success when that same memory comes
 * back. That is self-pollution: the relevance label IS corpus-query overlap by
 * construction, so a corpus of near-duplicates scores a "recall collapse" that
 * is really duplicate density, not a retrieval failure (flair#967 / #857 /
 * #996). This eval replaces that as the authoritative recall-quality number
 * with FIXED, hand-curated labels that are NOT derived from the corpus text.
 *
 * SINGLE SOURCE OF TRUTH: the corpus itself is the already-curated, already
 * deterministic v1 instrument in ../recall-harness/corpus.ts — reused verbatim
 * (not copied) so there is exactly one corpus + one set of labels. Its
 * `expectMarker`s were written by hand against one specific record and checked
 * that no other record answers the query more directly (see that file's
 * "GROUND TRUTH" header). We consume those hand assignments as the fixed
 * labels; we never recompute them from text.
 */
import { CORPUS, QUERIES } from "../recall-harness/corpus";
import type { SessionEvent, SessionHistory } from "../../../packages/flair-bench/lib/index";

/** Bench identity id-space. A record's Memory id is derived from its marker so
 *  a label can point at it deterministically — same scheme the recall-harness
 *  uses, kept distinct by AGENT_ID so the two never collide if both ever run
 *  against one instance. */
export const AGENT_ID = "recall-eval-layer1";
export const idFor = (marker: string): string => `${AGENT_ID}-${marker.replace(/::/g, "-")}`;

/** A labelled query: stable id, the query text, and the FIXED set of relevant
 *  memory ids (curated, corpus-independent). */
export interface LabelledQuery {
  id: string;
  q: string;
  kind: string;
  relevantIds: string[];
}

/** The curated corpus as per-event sessions (one Memory per record — the locked
 *  per-event granularity). Timestamps preserved: createdAt = now − ageDays, the
 *  same relative recency shape the harness seeds. Modelled as one session; the
 *  ingest flattens events regardless, and Layer 1 has no cross-session
 *  structure to preserve (Layer 2 will). */
export function buildCorpusSessions(now: number = Date.now()): SessionHistory[] {
  const events: SessionEvent[] = CORPUS.map((rec) => ({
    id: idFor(rec.marker),
    content: rec.text,
    durability: rec.durability,
    createdAt: now - rec.ageDays * 24 * 3600_000,
  }));
  return [{ sessionId: "layer1-recall-corpus", events }];
}

/** The labelled query set. Query id encodes kind + target + index so it is
 *  stable and human-readable in a failure. relevantIds is the FIXED curated
 *  label — one relevant memory per query (the corpus assigns exactly one). */
export const LABELLED_QUERIES: LabelledQuery[] = QUERIES.map((query, i) => ({
  id: `${query.kind}:${query.expectMarker}:${i}`,
  q: query.q,
  kind: query.kind,
  relevantIds: [idFor(query.expectMarker)],
}));

/** The fixed relevance labels as a plain map (queryId → relevant memory ids).
 *  This is the authoritative label — asserted-against in CI, and the thing the
 *  self-pollution mutation-check proves is NOT reproducible from corpus text. */
export const RELEVANCE_LABELS: Record<string, string[]> = Object.fromEntries(
  LABELLED_QUERIES.map((q) => [q.id, q.relevantIds]),
);

// ── Self-pollution control (for the mutation-check, NOT the eval) ────────────
//
// This reconstructs what a CORPUS-DERIVED labelling would produce: for each
// query, the label is the corpus record whose text has the highest lexical
// (token) overlap with the query text — i.e. relevance == query/corpus overlap,
// the exact defect the spot-check has. The eval never calls this; the
// mutation-check does, to prove (a) the curated labels differ from it (so they
// are real, not overlap artefacts) and (b) swapping to it changes the metric.

const STOPWORDS = new Set(
  "a an the of to in on for and or is are was were be been being do does did what which who whom whose how why when where that this these those it its as at by with from into your you my i me we our their they them he she his her".split(
    /\s+/,
  ),
);

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3 && !STOPWORDS.has(t)),
  );
}

/** For each labelled query, the id of the corpus record with the greatest
 *  token overlap with the query text — the self-polluting "relevance = overlap"
 *  labelling. Ties break to the earliest corpus record (deterministic). */
export function deriveLexicalOverlapLabels(): Record<string, string[]> {
  const corpusTokens = CORPUS.map((rec) => ({ marker: rec.marker, toks: tokenize(rec.text) }));
  const out: Record<string, string[]> = {};
  for (const lq of LABELLED_QUERIES) {
    const qToks = tokenize(lq.q);
    let bestMarker = corpusTokens[0]!.marker;
    let bestOverlap = -1;
    for (const { marker, toks } of corpusTokens) {
      let overlap = 0;
      for (const t of qToks) if (toks.has(t)) overlap++;
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestMarker = marker;
      }
    }
    out[lq.id] = [idFor(bestMarker)];
  }
  return out;
}

// ── Floors (the CI gate) ─────────────────────────────────────────────────────
//
// Per-metric minimums the eval must clear. Set BELOW the measured value by a
// margin that DWARFS the run-to-run noise band, so a breach means a real
// regression, not sampling wobble (#17 defect (b): the old threshold sat below
// the noise, so it could neither catch a regression nor avoid false alarms).
//
// Measured on this build (fresh clone, nomic-embed-text-v1.5-Q4_K_M, hybrid
// BM25+RRF on, scoring=raw, prefixes on = documented defaults), 3 independent
// spawn→ingest→retrieve runs — see ./run.ts output and the PR body:
//   recall@1  = 0.833   (spread 0.000 across 3 runs)
//   recall@5  = 0.967   (spread 0.000)
//   recall@10 = 0.967   (spread 0.000)
//   nDCG@10   = 0.917   (spread 0.000)
//   MRR       = 0.902   (spread 0.000)
// Noise band: 0.000 on every metric (fixed corpus + deterministic HNSW build,
// matching the recall-harness's own long-observed ±0.000). Each floor sits a
// margin below its measured value — recall@1 0.10 (≈3 queries at N=30),
// recall@5 0.10, recall@10 0.067, nDCG@10 0.097, MRR 0.102. Every margin is
// ≥2 whole queries and orders of magnitude above the 0.000 noise, so a breach
// is a real regression, never sampling wobble (the #17 defect (b) fix: the old
// threshold sat AT/below the noise instead of meaningfully above it).
export const FLOORS = {
  recallAt1: 0.73,
  recallAt5: 0.87,
  recallAt10: 0.9,
  ndcgAt10: 0.82,
  mrr: 0.8,
} as const;
