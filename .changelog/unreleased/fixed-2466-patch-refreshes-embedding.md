- **A memory PATCH that edits the text now refreshes its embedding, so a
  redacted or edited memory no longer keeps a stale vector.**

  A `PATCH /Memory/<id>` that changes `content` and supplies no vector computes
  a vector from the new text, the same way a `PUT` without a vector does, and
  stamps `embeddingModel` and `updatedAt`. When the embedding engine returns no
  vector the row is stored with its embedding cleared, so the re-embed picks it
  up instead of the memory keeping a vector for text it no longer holds. A PATCH
  that supplies no vector and leaves `content` unchanged or absent (one that
  edits only `summary` or `trigger`, say) leaves the stored vector alone: a
  memory's vector comes from its `content`, and skill memories, whose vector
  comes from `trigger`, cannot be patched. A PATCH that supplies a vector stores
  it. When redaction removes a supplied vector, the PATCH computes one from the
  `content` in its body, now also stamping `updatedAt`; a body without `content`
  now keeps the stored vector instead of recomputing it.
