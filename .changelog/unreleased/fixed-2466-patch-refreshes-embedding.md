- **A memory PATCH that edits the text now refreshes its embedding, so a
  redacted or edited memory no longer keeps a stale vector.**

  A `PATCH /Memory/<id>` that changes `content` (or a skill row's `trigger`) and
  supplies no vector computes one from the patched row, the same way a `PUT`
  without a vector does. When the embedding engine returns no vector the row is
  stored with its embedding cleared, so the existing re-embed path picks it up
  instead of the memory keeping a vector for text it no longer holds. A PATCH
  that supplies a vector, or changes no embedding-input field, is unchanged.
