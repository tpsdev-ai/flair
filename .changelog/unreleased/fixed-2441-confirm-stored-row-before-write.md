- **Three Memory write-backs confirm, inside their write, that the stored row is still the one they read.**

  The usage-count bump, the federation sync merge of a Memory row, and an
  ordinary `Memory.put` each read a Memory row and write it back carrying its
  server-stamped incarnation token. Each now re-reads the committed row inside
  the write and writes nothing when it is no longer the row it read, so a
  delete, a purge or a same-id replace committed between the read and the write
  is not undone or overwritten: the row stays gone, and a replaced row keeps its
  new content and token.

  `Memory.put` checks the committed row both before and after it stages the
  write, and refuses with 409 `stored_row_changed`. A federation sync skips the
  record as `merge_target_changed`. A refused usage-count bump leaves the count
  unchanged and is logged as `stored_row_changed`. A merge into any other synced
  table is unchanged.
