- **The synthetic CI migration and the operator purge write under the per-id Memory lock shared with owner PUT and PATCH.**

  The synthetic CI migration — registered only when
  `FLAIR_ENABLE_TEST_MIGRATIONS` is set — takes the row's lock with one
  non-waiting acquisition around its re-stamp of `source`. A held row, a row
  with an unresolved write outcome or a store with no lock writes nothing and
  is logged; the row stays pending for the next scan.

  `POST /MemoryPurge` takes the sorted per-id locks of its whole target set
  with the owner budget, re-resolves the set under them, and holds them across
  the row deletes, their deletion-history records and their commits. A set held
  for the whole budget answers `503 memory_busy` with the caller id and nothing
  else; a set that changed under the locks is restarted, then refused `409
  memory_purge_targets_changed`.

  `POST /AgentSeed` writes no existing Memory row: its starter memories are
  creates under a fresh id, so it takes no lock.

  The lock remains per process.
