- **Hybrid recall no longer rebuilds a full BM25 index on every query** (flair#1357;
  Kern's design ruling, 2026-08-23). The hybrid lexical leg used to fetch the
  ENTIRE scoped corpus out of Harper and call `buildBM25()` on it once per
  recall, so retrieval latency grew linearly with store size — measured p50 5.6s
  at 60k rows, 12.4s at 120k, 20.1s at 180k, extrapolating past 30s at 250k,
  while vector-only recall over the same stores moved only 2.4s → 4.7s. The
  lexical leg is now served from a persistent inverted index
  (`resources/bm25-index.ts`) built once per process and maintained
  incrementally from the Memory table's own change feed plus synchronous hooks
  on flair's write paths, so a query touches only the documents that contain its
  terms. Measured on a fixed 200-document matchable set inside a store grown 4×
  (10.2k → 40.2k documents): the old path 35.9ms → 137.2ms per query (3.83×),
  the new path 0.061ms → 0.059ms (0.96×, flat) — 584× and 2331× faster
  respectively. The whole scoped-corpus scan is also gone from the
  embedding-only search path, which never used it.

  **Ranking is unchanged, by construction and by proof.** The index derives
  per-query SCOPED BM25 statistics (N, avgdl, per-term df over exactly the
  documents the query's `conditions[]` and temporal filters admit) and
  accumulates term contributions in the same order as `buildBM25`, so scores are
  bit-identical. Anything it cannot reproduce exactly — an unrecognised
  condition attribute or comparator, or a `tags`+`subject` intersection — makes
  it decline, and the original per-query corpus scan answers instead. Unknown
  means slower, never different. Verified identical across 130 query shapes
  against a mocked Harper and 73 query shapes against a live instance over the
  same data directory, with a legacy-vs-legacy control run proving the harness
  itself is deterministic.

  `FLAIR_BM25_INDEX=false` (also `0` / `off`) forces every query back onto the
  original path with no rebuild — the same kill-switch shape as
  `FLAIR_HYBRID_RETRIEVAL`.
