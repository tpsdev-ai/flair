- **`flair integrity check` compares the live Memory corpus with an out-of-store checkpoint and alerts on unexplained loss of durable rows (Closes #2213).**

  The checkpoint holds per-tier counts AND the set of Memory ids (with
  durability) in `~/.flair/integrity-checkpoint.json` (mode 0600, written
  atomically), outside the Harper database. A durable-tier (`permanent` /
  `persistent`) row that is gone with no new deletion record is an unexplained loss:
  the report names the id and the checkpoint is not advanced until it is
  resolved or `--accept` re-baselines it. `Memory.delete` (including CLI hygiene
  and agent remove) and maintenance expiry record deletion history; tier changes
  are observed. Failed scans report UNKNOWN without advancing the checkpoint.
  The id set catches an equal-size replacement a count alone would miss.
