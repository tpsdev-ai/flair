- **The embedding-space guard fails closed on scans and notified writes that find an untrusted vector stamp.**

  The scan counts nonempty embeddings without a trusted
  current-space stamp. A count above zero makes the verdict non-uniform, so the recall leg refuses the
  query embedding and the write-time near-duplicate query compares no vectors;
  the row remains eligible for lexical matching. A guard-notified write without a
  trusted stamp advances the guard's scan epoch, so an in-flight scan cannot
  publish an older count. `flair doctor` prints the last published count in the
  `excluded` state. Raw operations-API inserts are uncovered until a rescan.
