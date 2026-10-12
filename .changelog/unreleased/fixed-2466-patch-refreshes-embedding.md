- **Ordinary PATCHes of existing memories refresh or clear embeddings on content changes when no supplied vector survives redaction (#2466).**

  The non-re-embed `PATCH /Memory/<id>` path compares the body's `content` with
  the stored text when no non-null supplied vector survives redaction. On a
  change it computes from the body's text and stamps `embeddingModel` and
  `updatedAt`; empty/non-string text or no returned vector yields null embedding fields.
  A fresh committed-row read runs only when the initial comparison selected no
  embedding, a stored row exists, and the vectorless body carries `content`.
  Other paths write without that confirmation.

  Without a refresh, the stored vector survives only if the body omits
  `embedding` (including when redaction removed it); an explicit null clears it.
  A surviving supplied vector is stored as supplied, without text/vector
  validation. Skill writes are refused on this ordinary path; the separate
  re-embed PATCH is unchanged.
