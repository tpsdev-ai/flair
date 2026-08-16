- **ADK-distilled session claims are now auto-promoted to the user's own
  memory, unattended.** After the per-user nightly distillation (#1205b-1)
  stages `MemoryCandidate`s each carrying an `adk:<app>:<user>` scope tag, the
  nightly cycle promotes the eligible ones to persistent memory server-side via
  a new `POST /AutoPromoteCandidates` resource — no human `rem promote` step for
  this narrow path. It runs only for ADK agents (an agentId with active `adk:`
  tags), is bounded per cycle, and is non-fatal (a failure is recorded and the
  candidates stay pending). Non-ADK candidates are unchanged: they still require
  the human `rem promote`. `flair rem nightly run-once` reports the count
  auto-promoted. Refs #1205 (completes the feature).
