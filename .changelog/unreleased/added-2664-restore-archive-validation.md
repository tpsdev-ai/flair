- **A restore-archive validator checks a backup's exact bytes and its Memory promotion fields; `flair restore` behaviour is unchanged.**
  The validator hashes an archive's bytes (SHA-256) and parses that same
  buffer once, as strict UTF-8 JSON. It refuses a repeated object key at any
  depth, a repeated row id within a collection, and rows `flair restore`
  already refuses. For selected Memory rows it requires string content, a
  declared `promotionStatus`, a non-empty `promotedAt` and `promotedBy` on an
  approved verdict, and a `promotionContentHash` that binds the archived
  content. Each row is reported as bound, legacy-unbound (a verdict with no
  binding, which readers suppress) or unpromoted. One failing row refuses the
  whole selection. Restore does not use it yet (flair#2664).
