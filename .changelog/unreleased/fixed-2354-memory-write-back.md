- **Memory write-backs re-read and confirm their target rows in owned transactions.**

  The write-back paths that read a Memory row and write the whole row back
  (feed ingest, administrator reindex, the last-reflected and promotion stamps,
  the embedding backfill, and the visibility and synthetic boot migrations) now
  share one helper: it reads the row inside a transaction it owns, builds the
  write from that read, and re-reads the committed row before commit.
