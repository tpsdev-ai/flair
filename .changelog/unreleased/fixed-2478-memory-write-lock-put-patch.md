- **The ordinary `PUT`/`PATCH` of a memory now takes the row's write lock and reads, decides and writes it in ONE transaction of its own (#2478).**

  Both verbs take the per-id memory write lock and run their ordinary write in an
  owned transaction whose FIRST operation is the authoritative stored read, so a
  concurrent owner write to the same id cannot interleave: a writer that cannot
  take the lock within its budget answers 503 `memory_busy`. Harper orders a
  transaction by its first read, so the read, the decision and the commit share
  one transaction — a background field-only write started later therefore folds
  around this older full update instead of being overwritten. After the commit, a
  fresh read confirms the committed row still carries the fields the write
  declared: a row replaced after the commit answers 409 `stored_row_changed`, and
  a verification read that fails answers 503 `write_outcome_unknown`. A manual
  promotion's memory write still joins the promotion's own transaction, so its
  approval stamp commits or rolls back with the row. The lock is per process, so
  it serializes writers within one instance only.
