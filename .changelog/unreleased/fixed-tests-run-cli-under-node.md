- **The persisted-admin and using-flair seed integration tests run the built CLI under Node (#2570).**

  `init-persisted-admin-harper5`, `using-flair-seed-2141`, and
  `using-flair-seed-reserved-2141` share a runtime helper that probes for Node.
  The test preload guards covered CLI/`harper.js` Bun launches: direct,
  `env COMMAND`, `env -S STRING` / `-SSTRING`,
  `env --split-string STRING` / `--split-string=STRING`, and
  `shell: true`, `sh -c`, `bash -c` strings beginning with bun after assignments.
  An override requires a nonempty reason set only in the child environment and is logged.
