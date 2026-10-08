- **Memory maintenance acts on the row it re-reads, not the scan-time copy
  (Closes #2275).**
  Each MemoryMaintenance action — ephemeral expiry, orphan pointer cleanup and
  the archive flag flip — re-reads the row inside a transaction it owns and acts
  only when that row is still the one the scan selected; a row another writer
  changed first is skipped and counted as skipped, never deleted, archived or
  swept. The archive write is built from the re-read row, so a concurrent edit
  is not reverted. A change committed between the re-read and the commit is
  settled by Harper's timestamp order. The user-facing archive/restore action
  (`MemoryArchive`) likewise re-reads the row inside an owned transaction and
  refuses a row that changed since it was read (`memory_changed`, 409) rather
  than writing the stale row back.
