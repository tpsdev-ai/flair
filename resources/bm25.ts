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
// ACTIVATED 2026-07-08 (ops-i39b activation follow-up to #519): default is now
// ON. Recall-eval validated at build time (CHANGELOG 0.20.x): NEW-8
// within-cluster gate p@3 holds 0.88 (no regression), OLD-6 severe
// near-verbatim misses recover 0/6 → 4/6 into top-10. A fresh isolated-Harper
// measurement at activation time (no prod contact) confirmed zero regression
// on both severe- and within-cluster-style synthetic queries and a small
// (~+4ms/query) latency delta. Set FLAIR_HYBRID_RETRIEVAL=false (also "0" /
// "off") to REVERT to the pre-hybrid legacy path — byte-identical to the
// original default-OFF behavior, no code rollback needed. Read per-call so it
// can be flipped without a rebuild and set per-case in tests. Lives here
// (Harper-free) so it's unit-testable.
export function hybridEnabled(): boolean {
  const v = (process.env.FLAIR_HYBRID_RETRIEVAL ?? "true").toLowerCase();
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
    // Score DESC, ties broken by ascending id (flair#1363, Kern-ruled
    // 2026-08-24, landed with the flair#1357 index work).
    //
    // This sort used to be `(a, b) => b.score - a.score` alone. Because
    // `Array.prototype.sort` is stable, equal-scoring documents then came back
    // in whatever order Harper's corpus scan had yielded them — and THAT order
    // is a query-plan artifact, not a property of the store. Measured against a
    // live instance (test/integration/bm25-index-scan-order-1357.test.ts): the
    // same rows, for the same query text, iterate in one order under the
    // multi-agent read-scope OR-group (the reader's own agentId-indexed rows
    // lead, everything else follows) and in a DIFFERENT one under a
    // tags/subject filter (plain primary-key order). Harper's planner is
    // cost-based, so which of those applies is a function of data
    // distribution. Hybrid recall was therefore nondeterministic for tied
    // documents, and nothing in the suite could see it — only exact score ties
    // move, and they move at the tail of the result window.
    //
    // Ties are NOT a curiosity: a document matching one rare query term once,
    // with the same token count as another such document, scores identically,
    // and flair's live corpus clusters at 19-33 tokens
    // (test/bench/corpus-profiler/profiles/corpus-v2.json). Measured at
    // realistic corpus shapes, 96-99% of queries have a tie inside the returned
    // window.
    //
    // Making the tie-break EXPLICIT is what lets resources/bm25-index.ts serve
    // the lexical leg at all: an index cannot reproduce a planner, but it can
    // reproduce `id` ascending. Both paths now sort exactly this way, so their
    // output is identical including tie order. The ranking change is confined
    // to documents whose BM25 scores are bit-identical — where there was no
    // defined order to preserve, only an accident to stop inheriting.
    scored.sort((a, b) => (b.score - a.score) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
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
// per-id score normalized to [0,1] (rrf / max_rrf_in_union). The top-ranked id
// is pinned at exactly 1.0 BY CONSTRUCTION — this is a RANKING value, not a
// similarity, and must never be reported as one (flair#985: reporting it as
// `_score` made every stale flair-client dedup gate see a ≥0.95 "similarity"
// on EVERY store and silently drop the write). semantic-retrieval-core.ts uses
// it to ORDER hybrid results (and as compositeScore's ranking input); the
// reported raw `_score` is the absolute cosine, computed separately.
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
