- **`flair integrity check` compares the live Memory corpus with an out-of-store checkpoint and alerts on unexplained loss of durable rows (Closes #2213).**

  The version-2 checkpoint holds per-tier counts AND Memory ids (with
  durability and `instanceToken`) in `~/.flair/integrity-checkpoint.json` (mode 0600, written
  atomically), outside the Harper database. A durable-tier (`permanent` /
  `persistent`) row gone without new history matching its nonempty checkpointed `instanceToken`
  is an unexplained loss. The checkpoint stays fixed on loss; a reappearing row
  can make the next scan healthy, or `--accept` re-baselines it. `Memory.delete` (including CLI hygiene
  and agent remove) and maintenance expiry record deletion history; tier changes
  are observed. Failed scans report UNKNOWN without advancing the checkpoint.
  The id set catches an equal-size replacement a count alone would miss.
  Version-1 checkpoints report UNKNOWN.
