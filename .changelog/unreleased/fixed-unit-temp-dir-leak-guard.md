- **A unit test that leaves a scratch directory behind now fails the unit lane (flair#1889).**

  Eight unit-test files take their scratch directory from the shared helper
  `tempDir()` in `test/helpers/temp-dir.ts`, which registers the directory's
  removal in the same call — a test cannot obtain one without its cleanup, and
  the removal runs through bun's test hooks, not a process-exit hook (bun's test
  runner does not run Node's `exit` listener). They are, under `test/unit/`,
  `changelog-fragments`, `changelog-release-notes`, `first-publish-check`,
  `first-run-hostile-verdict`, `release-sh-break-glass`, `secrets-push`,
  `temp-dir` and `version-check`. Other unit tests give their scratch directory
  their own hook-based cleanup, and the unit-lane guard covers them: it
  snapshots the `flair-*` names in the OS temp directory before and after the
  lane and fails when one appears, naming the new prefixes and their counts.

  (Refs #1889)
