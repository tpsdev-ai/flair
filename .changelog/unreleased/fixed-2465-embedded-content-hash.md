- **A server-computed Memory vector stores the hash of the text it was computed from (#2465).**

  When the server computes a Memory vector on a guarded path — an ordinary
  POST/PUT/PATCH embed, the re-embed PATCH, the stamp migration's
  `.content`-suffix fallback, or the auto-embed backfill — it stores a newly
  computed `embeddedContentHash`: the content hash of the exact text embedded
  (`trigger` for a skill-tagged row with a non-empty trigger, else `content`),
  or null for a row with an empty owner. A PUT or PATCH that does not compute a
  vector, and a skill successor that carries the stored vector, retain the
  stored value, which may describe an earlier server-computed vector. A POST or
  PUT create that stores a vector accepted from the caller stores null; when
  redaction changes the text, the supplied vector is discarded and the redacted
  text is embedded afresh, with a new hash when that yields a vector. An admin PATCH create drops a submitted
  value and can leave the field absent. The re-embed now confirms, after
  staging, that the committed row still has the identity and the exact text it
  embedded, so an edit to either that commits before the confirmation aborts
  the write. The embedding-stamp migration re-queues a row whose stored hash
  differs from the expected hash of its current text. An absent hash skips only
  that comparison, as a matching one passes it; either way the row also needs
  a current-space model. Its pending count is now a live scan, so it no longer
  opts into the runner's completion-gate recheck, which could otherwise pass
  the gate with a row pending only on its stored hash. `POST /FeedMemories`
  refuses a body `embeddedContentHash` (400 `feed_embedding_not_writable`).
