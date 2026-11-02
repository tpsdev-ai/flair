- **A migration state write refuses when another writer has taken its migration lock.**

  Before renaming `<dataDir>/.migrations/state.json`, the writer re-checks that
  the same holder still owns the lock file and otherwise fails with a named
  error, so a pre-take read-modify-write snapshot is not published over the
  other writer's entry. Releasing a lock no longer removes a lock file another
  holder has since acquired (#2866).
