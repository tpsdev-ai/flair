- **A deploy guard checkpoints Memory ids before a planned cluster operation and verifies them after.**
  `flair memory checkpoint` writes this instance's Memory ids and per-durability-tier counts to a
  mode-0600 file; `flair memory verify` re-reads the instance and reports verified, integrity failure
  (a checkpointed id gone, or a tier count dropped), or unknown — unknown when the instance or a page
  cannot be read, which is never reported as verified. `flair deploy --memory-checkpoint <path>` adds a
  data-convergence line to the deploy report, so component convergence is not read as data convergence
  (flair#2218).
