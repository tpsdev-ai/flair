- **Three Memory write-backs confirm, in their write's own transaction, that the stored row is still the one they read.**

  The usage-count bump, the federation sync merge, and `Memory.put` each read a
  Memory row and write it back carrying its server-stamped incarnation token.
  Each now re-reads the row inside the write's own transaction and writes nothing
  when it is no longer the row it read, so a delete, a purge or a same-id replace
  committed between the read and the write is not undone or overwritten: the row
  stays gone, and a replaced row keeps its new content and token.
