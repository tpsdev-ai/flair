- **Usage accounting, federation Memory merges, and Memory PUT updates confirm their target record before committing (#2441).**

  A detected target mismatch leaves the target unchanged. Memory PUT returns 409
  `stored_row_changed`; a federation Memory merge skips the record as
  `merge_target_changed`. A usage-count conflict leaves the count unchanged and
  is logged as `stored_row_changed`.
