- **`flair integrity check` alerts on unexplained loss of checkpointed durable Memory IDs or their nonempty tokens (Closes #2213).**

  The default version-2 checkpoint is `~/.flair/integrity-checkpoint.json` (mode 0600, written
  atomically); `--checkpoint` selects another path, which must stay outside Harper data.
  It holds per-tier counts and Memory ids (durability and `instanceToken`). A durable-tier (`permanent` /
  `persistent`) ID missing or present with a changed or missing previously nonempty `instanceToken`, without new history matching its nonempty checkpointed token,
  is an unexplained loss. On an alert, the whole checkpoint advances only with `--accept` and no reported
  replacement lacking a token; otherwise no checkpoint is written, even with other losses. Confirmed physical deletions of durable Memory rows through `Memory.delete` record history in the delete transaction; skill deletion closes the retained row and records none.
  Scans prune absorbed and untracked history after writing the checkpoint; non-durable deletes, including maintenance expiry, record none.
  Tier changes are reported even for replacements. Corpus and checkpoint read failures, exact-count mismatches, and a before/after exact-count difference around either search report UNKNOWN without advancing the checkpoint.
  Retention failures report UNKNOWN after checkpoint advancement, with `checkpointWritten: true`.
  Version-1 checkpoints report UNKNOWN.
  A row created and lost entirely between scans is not observed.
