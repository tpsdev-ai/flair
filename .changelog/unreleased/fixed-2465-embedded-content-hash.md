- **A server-computed Memory vector stores the hash of the text it was computed from (#2465).**

  When the server computes a Memory vector on a guarded path — an ordinary
  POST/PUT/PATCH embed, the re-embed PATCH, the stamp migration's
  `.content`-suffix fallback, or the auto-embed backfill — it stores a newly
  computed `embeddedContentHash`: the content hash of the exact text embedded
  (`trigger` for a skill-tagged row with a non-empty trigger, else `content`),
  or null for a row with an empty owner. A PUT or PATCH that does not compute a
  vector retains the stored value, which can then describe an earlier vector;
  a create with a caller-supplied vector stores null. The re-embed now
  confirms, after staging, that the committed row still holds the exact text
  it embedded, so an edit committed before that confirmation aborts the write.
  The embedding-stamp migration re-queues a row whose stored hash differs from
  the expected hash of its current text; a row with no stored hash counts as
  current. `POST /FeedMemories` refuses a body `embeddedContentHash` (400
  `feed_embedding_not_writable`).
