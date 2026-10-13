- **The ordinary `PUT`/`PATCH` of a memory now takes the row's write lock and writes it in a transaction of its own (#2478).**

  Both verbs take the per-id memory write lock before their first stored read,
  so a concurrent owner write to the same id cannot interleave with this one: a
  writer that cannot take the lock within its budget answers 503 `memory_busy`,
  and the row write commits in an owned transaction rather than joining the
  request's. After the commit, a fresh read confirms the committed row still
  carries the fields the write declared: a row replaced after the commit answers
  409 `stored_row_changed`, and a verification read that fails answers 503
  `write_outcome_unknown`. The lock is per process, so it serializes writers
  within one instance only.
