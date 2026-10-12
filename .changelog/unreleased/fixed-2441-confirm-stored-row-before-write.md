- **Usage accounting, federation Memory merges, and Memory PUT updates confirm their target record before committing (#2441).**

  A failed target confirmation leaves the target untouched.

  Memory PUT refuses a failed confirmation with 409 `stored_row_changed`.
  A federation sync skips the record as `merge_target_changed`.
  A refused usage-count bump leaves the count
  unchanged and is logged as `stored_row_changed`. A merge into any other synced
  table is unchanged.
