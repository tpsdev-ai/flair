- **A migration reports the rows whose write it could not confirm instead of
  counting them as done.** A row whose post-commit verification read did not
  show the write is left out of `rowsDone` unless a later attempt's write is
  verified. The synthetic CI migration, the visibility backfill and the
  embedding stamp's `.content`-suffix re-embed report such a row, from a
  returned batch and from a throw in the synthetic or visibility batch or the
  `.content`-suffix retry read, as `rowsUnconfirmed` (a count) and
  `unconfirmedIds` (up to 100 ids, shown to admin callers) in `/HealthDetail`.
  The runner attempts to write them to the migration state file when the run
  completes and when it halts, except on a `pre-flight integrity check failed`
  halt, which updates `/HealthDetail` only. State-file writes are
  best-effort. After a restart, the boot reads the state file in the data
  directory it selects for writes; when that file is readable, `/HealthDetail`
  shows its recorded outcome, and an unreadable file is treated as no record.
  The embedding stamp's loopback PATCH path logs a 503 `write_outcome_unknown`
  and leaves the row uncounted without naming it. The record is kept through
  cycles with no pending work, `detect()` failures and halts. A listed id is
  cleared once a later batch verifies its write or a later read finds its row
  at the migration's target or finds no row; a later cycle starts from the
  state file's list, so ids beyond the 100 listed stay in the count. (#2840)
