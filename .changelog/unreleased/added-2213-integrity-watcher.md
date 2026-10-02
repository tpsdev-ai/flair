- **`flair integrity check` compares the live Memory corpus with an out-of-store checkpoint and alerts on unexplained loss of durable rows (Closes #2213).**

  The checkpoint holds per-tier counts AND the set of Memory ids (with
  durability) in `~/.flair/integrity-checkpoint.json` (mode 0600, written
  atomically), outside the Harper database. A durable-tier (`permanent` /
  `persistent`) row that is gone with no deletion record is an unexplained loss:
  the report names the id and the checkpoint is not advanced until it is
  resolved. Deletes through Flair are recorded in the new `MemoryDeletionHistory`
  table and attributed; a durability change is attributed; a scan that cannot
  read the instance reports UNKNOWN and never overwrites the checkpoint. The id
  set is what catches an equal-size replacement a count alone would miss.
