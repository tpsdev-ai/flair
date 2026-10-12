- **Usage accounting, federation Memory merges, and Memory PUT confirm their target record before committing (#2441).**

  These paths leave a changed target untouched.

  Memory PUT refuses a failed confirmation with 409 `stored_row_changed`.
  A federation sync skips the record as `merge_target_changed`.
  A refused usage-count bump leaves the count
  unchanged and is logged as `stored_row_changed`. A merge into any other synced
  table is unchanged.
