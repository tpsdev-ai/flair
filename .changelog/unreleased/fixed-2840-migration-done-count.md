- **A migration reports the rows whose write it could not confirm instead of
  counting them as done.** A row whose post-commit verification read did not
  show the write is excluded from `rowsDone`. On a batch that returns, and on a
  batch that throws from the synthetic write-back, the visibility backfill or
  the embedding stamp's `.content`-suffix retry read, the row is recorded as
  `rowsUnconfirmed` (a count) and `unconfirmedIds` (up to 100 ids) in
  `/HealthDetail` and in the migration state file. The record survives a
  no-pending cycle, a restart, a `detect()` failure and every halt branch, and
  an id is cleared once a later batch verifies its write or a later read finds
  its row at the migration's target or finds no row. Applies to the synthetic
  CI migration, the visibility backfill and the embedding stamp's
  `.content`-suffix re-embed. (#2840)
