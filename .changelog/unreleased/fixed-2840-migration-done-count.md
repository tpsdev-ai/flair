- **A migration reports the rows whose write it could not confirm instead of
  counting them as done.** A row whose post-commit verification read did not
  show the write is excluded from `rowsDone`. The synthetic CI migration, the
  visibility backfill and the embedding stamp's `.content`-suffix re-embed
  record such a row as `rowsUnconfirmed` (a count) and `unconfirmedIds` (up to
  100 ids) in `/HealthDetail` and in the migration state file — when the batch
  returns, and for those paths when it throws. The embedding stamp's loopback
  PATCH path logs a 503 `write_outcome_unknown` and leaves the row uncounted
  without naming it. The record survives a no-pending cycle, a restart, a
  `detect()` failure and every halt branch, and an id is cleared once a later
  batch verifies its write or a later read finds its row at the migration's
  target or finds no row. (#2840)
