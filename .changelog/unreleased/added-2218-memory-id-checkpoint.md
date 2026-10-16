- **Operator-run checkpoint and post-operation check for Memory ids.**
  `flair memory checkpoint` writes this instance's Memory ids and per-durability-tier counts to a
  mode-0600 file; `flair memory verify` re-reads the same operations origin and reports verified,
  integrity failure (a checkpointed id gone, or a tier count dropped), or unknown — the comparison
  could not be completed (for example, an unreadable checkpoint, a different operations origin,
  a failed read, or a count change). An absent checkpoint exits 1 without a verification outcome.
  `flair deploy --memory-checkpoint <path>` adds a
  Memory id/tier check line to the deploy report; an integrity failure does not fail the deploy
  (flair#2218).
