- **The ordinary `PUT`/`PATCH` of a memory now runs under the row's write lock and commits before that lock releases (#2478).**

  Both verbs take the per-id memory write lock before their first stored read,
  and their row write owns its transaction instead of joining the request's, so
  the read, the decision and the commit all happen while the lock is held. A
  writer that cannot take the lock within its budget answers 503 `memory_busy`.

  After the commit, a fresh read confirms the committed row still carries the
  fields the write declared. A row replaced after the commit answers 409
  `stored_row_changed`; a verification read that fails answers 503
  `write_outcome_unknown`.

  > **Heads-up:** the admin-only `_reindex` re-PUT and the skill write path are
  > unchanged and still join the request's transaction.
