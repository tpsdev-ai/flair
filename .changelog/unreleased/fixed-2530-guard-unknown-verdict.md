- **The embedding-space guard fails closed: an unknown verdict is treated as not-uniform.**

  Before the first scan completes, or after a scan error, `isEmbeddingSpaceUniform()`
  returns false rather than defaulting to true, so semantic search and the
  write-time dedup leg take their mixed-space path. A recall with query text is
  keyword-only, and a recall with only a `queryEmbedding` returns no results;
  both, and `explain: true`, carry a warning that names the state (not yet
  verified, a failed scan with its bounded reason, or mixed). A store known to be
  mixed stays mixed when a scan fails, and a scan failure follows the same
  scan-start order as a verdict. Only a successful scan that finds one space
  reopens the gate. `flair doctor` reports the guard state from `/Health`,
  including from a not-ready 503 (now reported as an issue rather than as nothing
  responding); only a mixed store counts as an issue.
