- **A memory's stored vector records the hash of the text it was computed from (#2465).**

  The paths that (re)embed a row — the re-embed PATCH, the stamp migration's
  `.content`-suffix fallback, the auto-embed backfill, and an ordinary write that
  computes a vector — also record `embeddedContentHash`: the content hash of the
  exact text they embedded (`trigger` for a skill-tagged row with a non-empty
  trigger, else `content`). The re-embed's committed-row confirmation now also
  requires the row's embedding text to be unchanged, so an edit committed before
  that confirmation aborts the write instead of stamping a vector for the
  superseded text. The embedding-stamp migration re-queues a row whose recorded
  hash no longer matches its current text. A row with no recorded hash (written
  before this change) is trusted until a later write records a binding for it.
