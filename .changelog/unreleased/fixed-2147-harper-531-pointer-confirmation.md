- **POST /MemoryPurge confirms pointer-row removal through its own transaction, so a purge on Harper 5.3 no longer returns a false 500.**

  A table read with no transaction of its own resolves the request's operation
  transaction and reads that transaction's read snapshot. A purge pins that
  snapshot before it deletes the pointer rows, so the confirmation read still
  saw a pointer row that was already gone and answered
  `memory_purge_pointer_cleanup_failed`. The confirmation now reads through a
  transaction the purge owns and observes the committed delete.
