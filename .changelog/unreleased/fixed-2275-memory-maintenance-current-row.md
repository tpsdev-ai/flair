- **Memory maintenance acts on the row it re-reads, not the scan-time copy
  (Closes #2275).**
  Each MemoryMaintenance action — ephemeral expiry, orphan pointer cleanup and
  the archive flag flip — re-reads the row (for orphan cleanup, the pointer row
  and its Memory row) inside a transaction it owns and again in a fresh
  confirmation read, and acts only when those reads still match what the scan
  selected; a change either read sees is skipped and counted as skipped. A
  change committed between the confirmation read and the commit is not checked.
  The archive write is built from the re-read row. The user-facing
  archive/restore action (`MemoryArchive`) likewise re-reads the row inside an
  owned transaction: a changed persisted row that is still readable is refused
  (`memory_changed`, 409), a row that is no longer readable returns
  404, and a change after the re-read is not checked.
  The embedding-stamp migration re-embeds a stale row (other than a
  `.content`-suffix id) with the re-embed `PATCH /Memory/<id>`
  (`{"embedding": null, "embeddingModel": null}`), which embeds the row the
  PATCH handler reads and writes only `embedding`, `embeddingModel` and
  `updatedAt`. Edits committed before that stored-row read are kept.
  An edit committed while `Memory.patch()` awaits the embedding is a separate,
  tracked window. In 0.59.0 it sent a full-row `PUT` built from
  the row it had read, which overwrote a change committed between that read
  and the write.
