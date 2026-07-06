// ─── BM25 + union-RRF hybrid retrieval (Harper-free, unit-testable) ──────────
// Per spec FLAIR-BM25-HYBRID-RETRIEVAL (Kern-approved). This module is
// deliberately Harper-free — same rationale as ./scoring.ts — so the BM25
// scoring, the candidate-union RRF fusion, and the security conditions-filter
// can be unit-tested directly against the SHIPPED code without a live Harper.
//
// Ported from the pilot ops/tools/agent-fabric/bm25-rrf-pilot.mjs (commit
// 5552320), which validated: BM25 alone recovers 5/6 severe misses into top-3;
// candidate-UNION RRF (NOT naive whole-corpus RRF) recovers 4/6 into top-10 with
// no regression on the within-cluster gate (p@3 holds 0.88).

// ─── Feature flag: BM25 + union-RRF hybrid retrieval ────────────────────────
// Flag OFF (default) → SemanticSearch behavior is byte-identical to the
// pre-hybrid path (HNSW + the +0.05 exact-substring keyword bump). Flag ON → the
// hybrid path. Toggle with FLAIR_HYBRID_RETRIEVAL=true (also "1" / "on"). Read
// per-call so it can be flipped without a rebuild and set per-case in tests.
// Lives here (Harper-free) so it's unit-testable.
export function hybridEnabled(): boolean {
  const v = (process.env.FLAIR_HYBRID_RETRIEVAL ?? "").toLowerCase();
  return v === "true" || v === "1" || v === "on";
}

// BM25 parameters (Kern-approved): k1≈1.2, b≈0.75; standard IDF + BM25.
export const BM25_K1 = 1.2;
export const BM25_B = 0.75;

// RRF constant (Cormack et al. 2009 default). A doc absent from a list
// contributes 0 from that list (rank = ∞).
export const RRF_K = 60;

// BM25 candidate window — top-N by BM25 score fused into the union (spec §35:
// "BM25 uses a fixed SEM_LIMIT=50"). Independent of CANDIDATE_MULTIPLIER (the
// HNSW fetch size, which is left untouched).
export const SEM_LIMIT = 50;

// Tokenize: lowercase, split on non-alphanumeric, drop trivial stopwords and
// 1-char tokens. Standard, language-agnostic enough for the corpus.
const STOP = new Set(
  (
    "a an the and or but of to in on at for with from by as is are was were be been being " +
    "this that these those it its do does did so if then than when how what why who whom which while " +
    "i you he she we they them his her our your their not no yes can will would should could may might " +
    "have has had get got into out over under again about up down off all any each"
  ).split(" "),
);

export function tokenize(text: string): string[] {
  return ((text || "").toLowerCase().match(/[a-z0-9]+/g) || []).filter(
    (t) => t.length > 1 && !STOP.has(t),
  );
}

export interface BM25Doc {
  id: string;
  content?: string;
}

export interface BM25Scored {
  id: string;
  score: number;
}

export interface BM25Index {
  // Ranked (id, score) descending for a query string. Includes every doc
  // (score 0 for no-overlap docs) — callers slice/threshold as needed.
  rank(query: string): BM25Scored[];
  readonly N: number;
  readonly avgdl: number;
}

// Build a BM25 index over docs[].content. Standard Robertson/Sparck-Jones BM25
// with the +1 IDF variant (always non-negative — the common Lucene/Elasticsearch
// form).
export function buildBM25(docs: BM25Doc[]): BM25Index {
  const N = docs.length;
  const docTokens = docs.map((d) => tokenize(d.content || ""));
  const docLen = docTokens.map((t) => t.length);
  const avgdl = docLen.reduce((s, x) => s + x, 0) / (N || 1);

  const tfPerDoc = docTokens.map((toks) => {
    const tf = new Map<string, number>();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    return tf;
  });
  const df = new Map<string, number>();
  for (const tf of tfPerDoc) for (const term of tf.keys()) df.set(term, (df.get(term) || 0) + 1);
  const idf = new Map<string, number>();
  for (const [term, n] of df) idf.set(term, Math.log(1 + (N - n + 0.5) / (n + 0.5)));

  function rank(query: string): BM25Scored[] {
    const qToks = [...new Set(tokenize(query))];
    const scored = docs.map((d, i) => {
      const tf = tfPerDoc[i];
      const dl = docLen[i];
      let s = 0;
      for (const term of qToks) {
        const f = tf.get(term);
        if (!f) continue;
        const numer = f * (BM25_K1 + 1);
        const denom = f + BM25_K1 * (1 - BM25_B + BM25_B * (dl / (avgdl || 1)));
        s += (idf.get(term) || 0) * (numer / denom);
      }
      return { id: d.id, score: s };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored;
  }

  return { rank, get N() { return N; }, get avgdl() { return avgdl; } };
}

// ─── Reciprocal Rank Fusion over a candidate UNION ──────────────────────────
// rankings: array of ordered id-lists (best-first). A doc absent from a list
// contributes 0 from that list. `universe` = the id set fused over — for the
// production hybrid this is the candidate UNION (semantic ∪ bm25), NOT the whole
// corpus (naive whole-corpus RRF FAILS — the broken semantic list floods the
// fusion and buries BM25's rank-1 hits; pilot confirmed 0/6).
//
// Returns a Map id → raw RRF score. Caller normalizes + sorts.
export function rrfScores(rankings: string[][], universe: Iterable<string>): Map<string, number> {
  const score = new Map<string, number>();
  for (const id of universe) score.set(id, 0);
  for (const list of rankings) {
    list.forEach((id, idx) => {
      if (!score.has(id)) return; // doc not in this universe (union mode)
      score.set(id, (score.get(id) || 0) + 1 / (RRF_K + idx + 1)); // idx+1 = 1-based rank
    });
  }
  return score;
}

// Fuse semantic + BM25 candidate id-lists via candidate-union RRF and return a
// per-id score normalized to [0,1] (rrf / max_rrf_in_union). This normalized
// value is the rawScore fed to compositeScore so durability/recency/rBoost and
// the RBOOST_RELEVANCE_FLOOR / minScore thresholds still apply unchanged.
//
//   semIds  — semantic candidate ids, best-first (from the HNSW pass).
//   bm25Ids — BM25 candidate ids, best-first, already sliced to SEM_LIMIT and
//             already SECURITY-FILTERED (see filterBm25Candidates) BEFORE this call.
//
// The union dedupes ids across both lists. Absent-from-a-list = 0 contribution.
export function fuseRrfNormalized(semIds: string[], bm25Ids: string[]): Map<string, number> {
  const union = new Set<string>([...semIds, ...bm25Ids]);
  const raw = rrfScores([semIds, bm25Ids], union);
  let maxRrf = 0;
  for (const v of raw.values()) if (v > maxRrf) maxRrf = v;
  const norm = new Map<string, number>();
  if (maxRrf <= 0) {
    // Degenerate (empty union) — nothing to normalize.
    for (const [id] of raw) norm.set(id, 0);
    return norm;
  }
  for (const [id, v] of raw) norm.set(id, v / maxRrf);
  return norm;
}
