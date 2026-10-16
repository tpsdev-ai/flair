- **A stored Memory vector with no trusted current-space model stamp is excluded from vector similarity.**

  A write that supplies its own `embedding` and no `embeddingModel` stores a
  vector of unknown space; the embedding-space guard's scan skips a row with no
  space-bearing stamp, so its uniform verdict covers the stamped rows only. The
  HNSW vector leg in the shared retrieval core (SemanticSearch and
  MemoryBootstrap's task-relevant selection) and the near-duplicate ANN query now
  admit only rows whose `embeddingModel` is the current space — the
  engine-qualified id or its bare-name equivalent — so an untrusted stored vector
  is not cosined by a recall or the near-duplicate sweep. A write that stores no
  space-bearing stamp refreshes the guard's count on the next consult. The
  guard's verdict and `flair doctor`'s embedding-space line report how many rows
  were excluded and say the verdict covers stamped rows.
