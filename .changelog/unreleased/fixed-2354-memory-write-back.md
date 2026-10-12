- **Feed ingest, administrator reindex, last-reflected and auto-promotion stamps, and visibility and synthetic migrations confirm Memory write-back targets.**

  `POST /FeedMemories` refuses a body that sets `embedding` or `embeddingModel`
  (400 `feed_embedding_not_writable`), and answers a target row that changed
  during the write with a retryable 409 `feed_target_changed`. `POST /Memory`
  refuses a `derivedFrom` entry equal to the memory's own id (400
  `derived_from_self`). A manual promotion
  (`POST /PromoteMemoryCandidate`) whose verdict stamp fails now fails the
  request and leaves no promoted Memory row. The administrator reindex builds
  each row with the rules of `Memory.put()`'s `_reindex` re-PUT, so the
  `_reindex` flag is not stored.
