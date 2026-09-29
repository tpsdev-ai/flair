- **The CI dependency-age gate refuses the fixture-root override.** The gate is
  invoked in CI with an explicit `--ci` flag and now exits 2, naming
  `FLAIR_CHECK_DEP_AGES_ROOT`, when that variable is set on a CI run — so a
  stray environment variable cannot divert the CI gate away from the
  checked-out repository. The variable still points the gate at a fixture
  repository for tests, which do not pass `--ci`.
