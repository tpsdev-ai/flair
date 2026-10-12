- **A memory PATCH that edits the text now refreshes its embedding, so a
  redacted or edited memory no longer keeps a stale vector.**

  A `PATCH /Memory/<id>` that changes a memory's `content` and has no vector of
  its own to store computes a vector from the new text, the same way a `PUT`
  without a vector does, and stamps `embeddingModel` and `updatedAt`. Whether
  the text changes is decided against the stored row, and again against the
  committed row just before the write. When the embedding engine returns no
  vector the row is stored with its embedding cleared, so the re-embed picks it
  up instead of the memory keeping a vector for text it no longer holds.

  A PATCH that leaves `content` unchanged or absent (one that edits only
  `summary` or `trigger`, say) computes nothing and keeps the stored vector: an
  ordinary memory's vector comes from its `content`. Skill memories, whose
  vector comes from `trigger` (or from `content` when the trigger is empty or
  absent), cannot be patched. A PATCH that supplies a vector stores it, unless
  redaction changes the body's `content` or `trigger`: redaction then removes
  the supplied vector, and the PATCH computes one only when its `content`
  changes the stored text (now also stamping `updatedAt`); otherwise it now
  keeps the stored vector instead of recomputing it.
