- **The embedding-space guard fails closed: an unknown verdict is treated as not-uniform (#2545).**

  Before the first scan completes, or after a scan error, `isEmbeddingSpaceUniform()`
  returns false rather than defaulting to true, so semantic search and the
  write-time dedup leg take their mixed-space path. For guarded vector requests, recall omits the embedding leg and warns about the current `unverified`, `scan-failed`, `mixed` or `excluded` state. bm25-only, which never uses a query
  embedding, does not consult the guard. The `mixed` state persists when a scan
  fails, and a scan failure follows the same scan-start order as a verdict. Only a successful scan finding no foreign model stamp and no stored vector without a trusted current-space stamp reopens the gate. `flair
  doctor` reports the guard state from `/Health`, including from a 503 with
  `searchReady: false`, which it reports as an issue rather than as nothing
  responding. Among guard states, `mixed` and `excluded` increment doctor's issue count; readiness has its own issue.
