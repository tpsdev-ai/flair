- **Internal integrity custody and commit-fence primitives for the scheduled integrity watcher; no command, route or baseline is reachable yet.**

  Commits, tombstones and recovery share one custody lock. Generation commits
  and tombstones stage an intent marker before publication. Open refuses
  retained generation entries without CURRENT and symlinked generations.
  New custody refuses an existing registry (#971).
