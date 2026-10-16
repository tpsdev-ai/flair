- **The embedding-space guard fails closed on scans and notified writes that find an untrusted vector stamp.**

  The scan counts arrays and typed arrays, including empty ones, without a trusted
  current-space stamp. A count above zero makes the verdict non-uniform, so the recall
  leg refuses the query embedding and the write-time near-duplicate query compares no vectors;
  the row remains eligible for lexical matching. Guard-notified writes invalidate
  the count when their stamp is untrusted or they may repair an untrusted vector.
  `flair doctor` prints the last published count in the `excluded` state. Raw operations-API inserts are uncovered until a rescan.
