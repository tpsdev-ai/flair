- **The listed Memory write-back paths re-read and confirm their target rows in owned transactions.**

  These paths read a Memory row and write the whole row back, and now share
  one helper: feed ingest, administrator reindex, the last-reflected and
  auto-promotion stamps, the embedding backfill, and the visibility and
  synthetic boot migrations. The helper reads the row inside a transaction it
  owns, builds the write from that read, and re-reads the committed row before
  commit.

  `POST /FeedMemories` refuses a body that sets `embedding` or `embeddingModel`
  (400 `feed_embedding_not_writable`), and answers a target row that changed
  during the write with a retryable 409 `feed_target_changed`. `POST /Memory`
  refuses a `derivedFrom` entry equal to the memory's own id (400
  `derived_from_self`). A manual promotion
  (`POST /PromoteMemoryCandidate`) whose verdict stamp fails now fails the
  request and leaves no promoted Memory row. The administrator reindex builds
  each row with the rules of `Memory.put()`'s `_reindex` re-PUT, so the
  `_reindex` flag is not stored.
