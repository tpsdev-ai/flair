- **Concurrent full-row Memory write-backs no longer revert a concurrent change.**

  The write-back paths that read a Memory row and write the whole row back
  (feed ingest, administrator reindex, the last-reflected and promotion stamps,
  the embedding backfill, and the visibility and synthetic boot migrations) now
  share one helper: it reads the row inside a transaction it owns, builds the
  write from that read, and re-reads the committed row before commit. A change
  committed in between aborts the write and retries from the committed row
  instead of overwriting it with the stale read. A row that keeps changing
  across the bounded attempts is refused, never reported as written.
