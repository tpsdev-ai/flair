- **`flair integrity check` alerts on missing or replaced checkpointed durable Memory IDs without matching new deletion history (Closes #2213).**

  The version-2 checkpoint holds per-tier counts AND Memory ids (with
  durability and `instanceToken`) in `~/.flair/integrity-checkpoint.json` (mode 0600, written
  atomically), outside the Harper database. A durable-tier (`permanent` /
  `persistent`) ID missing or present with a different `instanceToken`, without new history matching its nonempty checkpointed token,
  is an unexplained loss. The checkpoint stays fixed on loss; a row returning with its checkpointed token
  can make the next scan healthy, or `--accept` re-baselines it. `Memory.delete` (including CLI hygiene
  and agent remove) and maintenance expiry record deletion history; tier changes
  are observed. Failed scans report UNKNOWN without advancing the checkpoint.
  Version-1 checkpoints report UNKNOWN.
  A row created and lost entirely between scans is not observed.
