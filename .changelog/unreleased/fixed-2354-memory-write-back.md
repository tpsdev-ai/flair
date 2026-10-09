- **Memory write-backs re-read and confirm their target rows in owned transactions.**

  The write-back paths that read a Memory row and write the whole row back
  (feed ingest, administrator reindex, the last-reflected and auto-promotion stamps,
  the embedding backfill, and the visibility and synthetic boot migrations) now
  share one helper: it reads the row inside a transaction it owns, builds the
  write from that read, and re-reads the committed row before commit.

  `POST /FeedMemories` refuses a body that sets `embedding` or `embeddingModel`
  (400 `feed_embedding_not_writable`). A manual promotion
  (`POST /PromoteMemoryCandidate`) whose verdict stamp fails now fails the
  request and leaves no promoted Memory row. The administrator reindex builds
  each row with the rules of `Memory.put()`'s `_reindex` re-PUT, so the
  `_reindex` flag is not stored.
