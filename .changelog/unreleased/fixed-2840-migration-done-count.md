- **A migration counts a row as done only when its write is confirmed, and
  reports the rows it could not confirm.** `rowsDone` excludes any row whose
  post-commit verification read did not show the write. Those rows are recorded
  as `rowsUnconfirmed` (a count) and `unconfirmedIds` (up to 100 ids) in
  `/HealthDetail` and in the migration state file. The record survives a
  no-pending cycle and a restart, and an id is cleared once a later cycle finds
  its row at the migration's target or finds no row. Applies to the synthetic CI
  migration, the visibility backfill and the embedding stamp's `.content`-suffix
  re-embed. (#2840)
