- **Each converted Memory write names only its patch fields; it does not write the rest of the row.**

  The embedding backfill, the usage-count bump, the maintenance archive, the
  feed dedup repair, the last-reflected stamp and the synthetic boot migration
  each used to write back the whole row they read. Harper orders a transaction by
  its first read, so a whole-row write that committed at a newer timestamp could
  supersede an owner `PUT` whose transaction had opened earlier — and that `PUT`
  still answered 200. Each now writes only its named patch fields, through an
  incremental update (`writeBackCommittedRow` accepts an `update` plan), and
  still confirms the committed row before committing.

  This does not close the owner-first interleaving: where an owner write that
  started earlier commits after a converted writer's newer field patch, the
  writer's field still wins for the fields it names.

  Not converted here — #2478: the `visibility` backfill (still whole-row here;
  its field decision depends on the owner-controlled `visibility`) and the
  auto-promotion stamp (still whole-row here; its field decision depends on
  the owner-controlled content).

  The re-embed and the embedding-stamp fallback are converted separately
  (#2465): they write only `embedding`, `embeddingModel` and `updatedAt`.
