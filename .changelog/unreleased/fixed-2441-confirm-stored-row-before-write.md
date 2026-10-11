- **Three Memory write-backs confirm, inside their write, that the stored row is still the one they read.**

  The usage-count bump, the federation sync merge of a Memory row, and an
  ordinary `Memory.put` each read a Memory row and write it back carrying its
  server-stamped incarnation token. Each now re-reads the committed row inside
  the write. A missing row or a same-id replacement that changes `instanceToken`,
  `contentHash`, `createdAt` or `agentId` before the re-read is refused.

  `Memory.put` checks the committed row both before and after it stages the
  write, and refuses with 409 `stored_row_changed`. A federation sync skips the
  record as `merge_target_changed`. A refused usage-count bump leaves the count
  unchanged and is logged as `stored_row_changed`. Federation merge writes to `Soul`,
  `Agent`, `Relationship` and `Message` now compare the whole stored row.
