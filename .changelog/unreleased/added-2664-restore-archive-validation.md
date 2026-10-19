- **A restore-archive validator checks a backup's exact bytes and its Memory promotion fields; `flair restore` behaviour is unchanged.**
  The validator hashes an archive's bytes (SHA-256) and parses that same
  buffer once, as strict UTF-8 JSON. It refuses a repeated object key at any
  depth, a repeated row id within a collection, and rows `flair restore`
  already refuses. Selected Memory rows need string content. Their promotion
  fields are checked when present: `promotionStatus` must be a declared
  value, an approved verdict needs a non-empty `promotedAt` and `promotedBy`,
  and a `promotionContentHash` must bind the archived content. Rows without a
  verdict, and verdicts without a hash, are admitted. Each row is reported as
  bound, legacy-unbound (a verdict with no binding, which readers suppress)
  or unpromoted. One failing row refuses the whole selection. Restore does
  not use the validator yet (flair#2664).
