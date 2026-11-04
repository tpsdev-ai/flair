- **Nightly REM `run-once` now reads the admin password from the owner-only
  file path baked into the scheduler shim, so the dedup-cluster step can
  authenticate.** `flair rem nightly enable` resolves the absolute path at
  enable time (override with `--admin-pass-file`); the shim passes the path
  as one quoted argument, never the value. A missing, empty, or too-open file
  fails the run at startup before any cycle work: the dedup step reports NOT
  RUN with the path and remedy, and the command exits nonzero on every path,
  including a paused cycle and a dry run. Re-run `flair rem nightly enable` on
  an existing install to rewrite the shim.
