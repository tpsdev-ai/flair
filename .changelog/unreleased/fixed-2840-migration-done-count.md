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
  best-effort. The embedding stamp's loopback PATCH path reports a 503
  `write_outcome_unknown` row as unconfirmed. A
  listed id is cleared once a later batch verifies its write or a later read
  finds its row needs no further write from the migration or finds no row. The runner writes
  at most 100 ids into the state file's record, and a later cycle starts from
  the record it reads back, so ids beyond those 100 are carried only in its
  count. (#2840)
