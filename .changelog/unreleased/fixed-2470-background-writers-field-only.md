- **Background Memory writers now update only the fields they own, so a concurrent owner edit is no longer reverted by a whole-row write.**

  The `visibility` boot migration, the embedding backfill, the usage-count
  bump, the auto-promotion stamp, the feed dedup repair, the last-reflected
  stamp and the synthetic boot migration each used to write the whole row they
  read back. Harper orders a transaction by its
  first read, so a whole-row write that committed at a newer timestamp could
  supersede an owner `PUT` whose transaction had opened earlier — and that
  `PUT` still answered 200. Each now writes only the fields it owns, through an
  incremental update (`writeBackCommittedRow` accepts an `update` plan), and
  still confirms the committed row before committing.

  The re-embed paths are a separate change and are not touched here.
