- **Nightly REM `run-once` now reads the admin password from the owner-only
  file path baked into the scheduler shim, so the dedup-cluster step can
  authenticate.** `flair rem nightly enable` resolves the absolute path at
  enable time (override with `--admin-pass-file`); the shim passes the path
  only, never the value. A missing or too-open file reports the dedup step
  NOT RUN, names the path and the remedy, and exits nonzero. Re-run
  `flair rem nightly enable` on an existing install to rewrite the shim.
