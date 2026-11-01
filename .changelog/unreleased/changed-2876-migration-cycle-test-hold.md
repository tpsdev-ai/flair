- **A test-only hold at the start of a migration cycle, for observing boot-seeded progress.** With
  `FLAIR_ENABLE_TEST_FAULT_INJECTION=1`, an arm file, a valid private temporary directory
  in `FLAIR_TEST_PAUSE_DIR`, and an unclaimed marker, a cycle pauses after taking its lock
  and before reading the state file, then resumes on a go file or timeout.

  It ships in `resources/` because the real-Harper test drives a spawned server. Without those
  test variables it is inert.
