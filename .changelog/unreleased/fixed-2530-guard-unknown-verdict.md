- **The embedding-space guard fails closed: an unknown verdict is treated as not-uniform.**

  Before the first scan completes, or after a scan error, `isEmbeddingSpaceUniform()`
  returns false rather than defaulting to true, so semantic search and the
  write-time dedup leg take their mixed-space path. When a query embedding is
  available outside bm25-only mode, a recall with query text is keyword-only, a
  recall with only a `queryEmbedding` returns no results, and `explain: true`
  returns a plan with no embedding leg; each carries a warning that names the
  state: not yet verified, a failed scan with its bounded reason, or `mixed` (a
  non-current embedding model stamp was observed; the warning formerly said the
  store had mixed embedding spaces). bm25-only, which never uses a query
  embedding, does not consult the guard. The `mixed` state persists when a scan
  fails, and a scan failure follows the same scan-start order as a verdict. Only
  a successful scan that finds every space-bearing `embeddingModel` stamp in the
  current space reopens the gate: the guard checks stamp metadata, ignoring a
  missing stamp and the hash-fallback marker `hash-512d`, so a stored vector
  without a space-bearing stamp is not checked (deferred to #2573). `flair
  doctor` reports the guard state from `/Health`, including from a 503 with
  `searchReady: false`, which it reports as an issue rather than as nothing
  responding. Among the guard states, only `mixed` increments doctor's issue
  count; readiness has its own issue.
