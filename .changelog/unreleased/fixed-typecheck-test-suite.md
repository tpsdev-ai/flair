- **The test suite is now type-checked in CI.** Both project tsconfigs excluded `test/`, so
  `tsc --noEmit` — what CI runs as its Type Check lane — never read a test file, and bun's
  transpiler strips types rather than checking them. A guard test could call a function that
  no longer exists, pass a wrong-shaped argument, or assert against a renamed property, and
  the only signal was whether it happened to fail at runtime. That matters most for guard
  tests, which are how we know a control still works. A new `tsconfig.test.check.json` covers
  the suite under `strict`, with an explicit exclude list for the files carrying a known
  backlog — a visible, shrinkable list rather than a blanket relaxation, since relaxing the
  compiler options until everything passed would have bought coverage of ~30 files by
  weakening the check on ~260.
