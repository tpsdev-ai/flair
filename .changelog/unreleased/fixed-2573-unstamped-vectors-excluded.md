- **The embedding-space guard fails closed on scans and notified writes that find an untrusted vector stamp.**

  A PUT create that supplies its own `embedding` and no `embeddingModel` stores a
  vector of unknown space. The embedding-space guard's scan now counts every row
  that stores a vector and whose `embeddingModel` is not a trusted current-space
  stamp, compared exactly as the vector query's stamp condition compares it. A
  count above zero makes the verdict non-uniform, so the recall leg refuses the
  query embedding and the write-time near-duplicate query compares no vectors;
  the row still matches on a lexical leg. A guard-notified write without a
  trusted stamp advances the guard's scan epoch, so an in-flight scan cannot
  publish an older count. `flair doctor` prints the last published count in the
  `excluded` state. Raw operations-API inserts are uncovered until a rescan.
