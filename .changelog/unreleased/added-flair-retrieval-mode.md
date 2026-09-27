- **The server environment selector `FLAIR_RETRIEVAL_MODE` supports `hybrid`, `vector-only` and `bm25-only` retrieval for benchmark runs.**

  This selector is intended for benchmark runs and has no CLI flag. When it is
  unset, `FLAIR_HYBRID_RETRIEVAL` selects hybrid for `true`, `1` or `on`
  (case-insensitively), and vector-only for other values; leaving both variables
  unset selects hybrid.
  In `bm25-only` mode, retrieval ranks using BM25 alone, without a vector leg
  or query-embedding generation.
