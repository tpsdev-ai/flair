- **A stored Memory vector with no trusted current-space model stamp makes the
  embedding-space guard's verdict non-uniform.**

  A write that supplies its own `embedding` and no `embeddingModel` stores a
  vector of unknown space. The embedding-space guard's scan now counts every row
  that stores a vector and whose `embeddingModel` is not a trusted current-space
  stamp, compared exactly as the vector query's stamp condition compares it. A
  count above zero makes the verdict non-uniform, so the recall leg refuses the
  query embedding and the write-time near-duplicate query compares no vectors;
  the row still matches on a lexical leg. A write that stores a vector without a
  trusted stamp advances the guard's scan epoch, so an in-flight scan cannot
  publish an older count. `flair doctor`'s embedding-space line reports the
  count.
