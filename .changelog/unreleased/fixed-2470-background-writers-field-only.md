- **The converted Memory writers now update only the fields they own, so they no longer overwrite a field they do not own.**

  The embedding backfill, the usage-count bump, the maintenance archive, the
  feed dedup repair, the last-reflected stamp and the synthetic boot migration
  each used to write back the whole row they read. Harper orders a transaction by
  its first read, so a whole-row write that committed at a newer timestamp could
  supersede an owner `PUT` whose transaction had opened earlier — and that `PUT`
  still answered 200. Each now writes only the fields it owns, through an
  incremental update (`writeBackCommittedRow` accepts an `update` plan), and
  still confirms the committed row before committing.

  This does not close the owner-first interleaving: where an owner write that
  started earlier commits after a converted writer's newer field patch, the
  writer's field still wins for the fields it names. That is tracked in #2478
  (per-id serialization; design first, separate PR), not here.

  Not converted here — #2478: the `visibility` backfill (still whole-row on main;
  its field decision depends on the owner-controlled `visibility`) and the
  auto-promotion stamp (still whole-row on main; its field decision depends on
  the owner-controlled content).

  The re-embed paths are a separate change (#2469) and are not touched here.
