- **Background Memory writers now update only the fields they own, so they no longer overwrite a field they do not own.**

  The `visibility` boot migration, the embedding backfill, the usage-count
  bump, the auto-promotion stamp, the maintenance archive, the feed dedup
  repair, the last-reflected stamp and the synthetic boot migration each used
  to write the whole row they read back. Harper orders a transaction by its
  first read, so a whole-row write that committed at a newer timestamp could
  supersede an owner `PUT` whose transaction had opened earlier — and that
  `PUT` still answered 200. Each now writes only the fields it owns, through an
  incremental update (`writeBackCommittedRow` accepts an `update` plan), and
  still confirms the committed row before committing. The `visibility` backfill
  and the auto-promotion stamp additionally re-confirm on the committed row the
  precondition their decision used (the visibility still absent; the reviewed
  content hash unchanged) and skip the row by name otherwise.

  This does not close the owner-first interleaving: where an owner write that
  started earlier commits after a writer's newer field patch, the writer's field
  still wins for the fields it names (visibility for the backfill, the promotion
  fields for auto-promotion). That is tracked in #2478 (per-id serialization;
  design first, separate PR), not here.

  The re-embed paths are a separate change (#2469) and are not touched here.
