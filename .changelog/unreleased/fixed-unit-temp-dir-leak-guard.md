- **A unit test that leaves a scratch directory behind now fails the unit lane (flair#1889).**

  Every unit test that needs a scratch directory takes it from one shared helper,
  `tempDir()` in `test/helpers/temp-dir.ts`, which registers the directory's
  removal in the same call — a test cannot obtain one without its cleanup, and
  the removal runs through bun's test hooks, not a process-exit hook (bun's test
  runner does not run Node's `exit` listener). The unit lane snapshots the
  `flair-*` names in the OS temp directory before and after the lane and fails
  when one appears, naming the new prefixes and their counts.

  (Refs #1889)
