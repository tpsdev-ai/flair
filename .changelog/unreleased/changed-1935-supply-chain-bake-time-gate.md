- **The supply-chain bake-time gate always runs (no main-detection guard), and two critical exit code paths are tested.**
  The `scripts/check-dep-ages.mjs` script no longer checks `import.meta.url` to
  determine whether it is the entry — the guard was removed by moving
  `collectDeps` (and related helpers) into a dedicated lib module at
  `scripts/lib/check-dep-ages-collect.mjs` with type declarations at
  `scripts/lib/check-dep-ages-collect.d.mts`.  The unit test now imports from
  the lib module rather than the CLI script, and a space-path test was
  removed (the guard it tested no longer exists).  A new test helper at
  `test/fixtures/run-ffi-check.sh` starts a local `node` HTTP server that
  returns publish-time = "now"; the CLI test against it verifies the too-fresh
  exit (`1`), while the registry-failure test verifies exit `2`.
  (Refs #1935)
