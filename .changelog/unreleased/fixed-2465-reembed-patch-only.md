- **A background re-embed writes only the embedding fields (#2465).**
  `Memory.patch()`'s re-embed branch — reached by `flair reembed`, a direct
  `PATCH /Memory/<id>` whose body is `{"embedding": null, "embeddingModel": null}`, and the
  embedding-stamp migration — wrote the whole row it re-read inside its transaction. Harper
  orders a transaction by its first read, so that full-row write could carry a row read before
  an owner edit and revert the edit, even though the edit's own `PUT` had answered 200. Both
  re-embed paths now write only `embedding`, `embeddingModel` and `updatedAt`: the HTTP PATCH
  branch (which also re-reads the committed row before writing, so a row deleted in the
  meantime is skipped with `404` instead of being re-created from the patch fields) and the
  migration's `.content`-suffix fallback, whose id the by-id PATCH path cannot address and
  which therefore writes through the raw table handle.
