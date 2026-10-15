- **The persisted-admin and using-flair seed integration tests run the built CLI under Node (#2570).**

  `init-persisted-admin-harper5`, `using-flair-seed-2141`, and
  `using-flair-seed-reserved-2141` share a runtime helper that probes for Node.
  The test preload refuses Bun spawns of the shipped CLI that can start a local
  instance, including `doctor --fix`, and direct `harper.js` invocations.
  A per-call environment override requires a nonempty reason and is logged.
