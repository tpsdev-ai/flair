- **`flair integrity check` alerts on unexplained loss of checkpointed durable Memory IDs or their nonempty tokens (Closes #2213).**

  The default version-2 checkpoint is `~/.flair/integrity-checkpoint.json` (mode 0600, written
  atomically); `--checkpoint` selects another path, which must stay outside Harper data.
  It holds per-tier counts and Memory ids (durability and `instanceToken`). A durable-tier (`permanent` /
  `persistent`) ID missing or present with a changed or missing previously nonempty `instanceToken`, without new history matching its nonempty checkpointed token,
  is an unexplained loss. On an alert, the whole checkpoint advances only with `--accept` and no reported
  replacement lacking a token; otherwise no checkpoint is written, even with other losses. `Memory.delete` (including CLI hygiene
  and agent remove) and maintenance expiry record deletion history; tier changes
  are reported even for replacements. Failed scans, exact-count mismatches, and a before/after exact-count difference around either search report UNKNOWN without advancing the checkpoint.
  Version-1 checkpoints report UNKNOWN.
  A row created and lost entirely between scans is not observed.
