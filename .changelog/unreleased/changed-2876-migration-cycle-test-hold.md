- **A test-only hold at the start of a migration cycle, for observing boot-seeded progress.** With
  `FLAIR_ENABLE_TEST_FAULT_INJECTION=1` and an arm file in `FLAIR_TEST_PAUSE_DIR`, a cycle pauses
  after taking its lock and before reading the state file, and resumes on a go file.

  It ships in `resources/` because the real-Harper test drives a spawned server. Without those
  test variables it is inert.
