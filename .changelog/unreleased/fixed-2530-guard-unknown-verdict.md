- **The embedding-space guard fails closed: an unknown verdict is treated as not-uniform.**

  Before the first scan completes, or after a scan error, `isEmbeddingSpaceUniform()`
  returns false rather than defaulting to true, so semantic search and the
  write-time dedup leg take their mixed-space path — keyword-only recall with a
  warning that names the state (not-yet-verified before the first scan; a failed
  scan with its bounded reason after an error). A scan error is logged once per
  error class and the guard retries on its existing schedule; `flair doctor`
  reports the guard state.
