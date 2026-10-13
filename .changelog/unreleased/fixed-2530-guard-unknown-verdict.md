- **The embedding-space guard fails closed: an unknown verdict is treated as not-uniform.**

  Before the first scan completes, or after a scan error, `isEmbeddingSpaceUniform()`
  returns false rather than defaulting to true, so semantic search and the
  write-time dedup leg take their mixed-space path: keyword-only recall with a
  warning that names the state (not yet verified before the first scan; a failed
  scan with its bounded reason after an error), and `explain: true` output
  carries the same warning. A store already known to be mixed stays mixed when a
  rescan fails. A scan error is logged once per error class and the guard retries
  on its existing schedule; only a successful scan that finds one space reopens
  the gate. `flair doctor` reports the guard state from `/Health`, including from
  a not-ready 503, which it now reports as an issue instead of as nothing
  responding.
