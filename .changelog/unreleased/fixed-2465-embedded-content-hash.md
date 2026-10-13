- **A vector the server computes records the hash of the text it embedded (#2465).**

  When the server computes a Memory vector on a guarded path — an ordinary
  POST/PUT/PATCH embed, the re-embed PATCH, the stamp migration's
  `.content`-suffix fallback, or the auto-embed backfill — it also records
  `embeddedContentHash`: the content hash of the exact text embedded (`trigger`
  for a skill-tagged row with a non-empty trigger, else `content`). The re-embed
  now confirms, after staging, that the committed row still holds the exact text
  it embedded, so an edit committed before that confirmation aborts the write.
  The embedding-stamp migration re-queues a row whose recorded hash no longer
  matches its current text. A row with no recorded hash (for example, one
  written before this change or created with a caller-supplied vector) counts
  as current.
  `POST /FeedMemories` refuses a body `embeddedContentHash` (400
  `feed_embedding_not_writable`).
