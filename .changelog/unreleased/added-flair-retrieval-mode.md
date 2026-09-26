- **`FLAIR_RETRIEVAL_MODE` selects hybrid, vector-only or bm25-only retrieval for benchmarking; the default (hybrid) is unchanged and `FLAIR_HYBRID_RETRIEVAL` keeps its meaning.**

  It is a benchmark measurement knob, not a shipped toggle: there is no CLI
  flag and no default change. `bm25-only` ranks on the BM25 lexical leg alone —
  no vector leg and no query embedding — so a harness can measure BM25 recall
  against hybrid and vector-only on the same corpus.
