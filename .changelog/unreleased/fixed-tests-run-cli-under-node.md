- **Verify the CLI runtime in persisted-admin and using-flair seed integration tests (#2570).**

  `init-persisted-admin-harper5`, `using-flair-seed-2141`, and
  `using-flair-seed-reserved-2141` share a runtime helper that probes for Node.
  `FLAIR_TEST_ALLOW_BUN_HARPER` requires a nonempty reason set only in the child environment and is logged.
