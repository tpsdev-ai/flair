- **Migrations count a row as done only when its committed write was verified,
  and report the rows they could not verify.** `rowsDone` excludes any row whose
  post-commit verification read did not show the write. Those rows are reported
  separately as `rowsUnconfirmed` (an exact count) and `unconfirmedIds` (up to
  100 ids) in `/HealthDetail` and in the migration state file, so a migration
  that completes with unconfirmed rows says so instead of counting them as done.
  Applies to the synthetic CI migration, the visibility backfill and the
  embedding stamp's `.content`-suffix re-embed. (#2840)
