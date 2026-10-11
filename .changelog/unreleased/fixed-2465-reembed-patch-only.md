- **A background re-embed writes only the embedding fields (#2465).**
  `Memory.patch()`'s re-embed branch — reached by `flair reembed`, a direct
  `PATCH /Memory/<id>` whose body is `{"embedding": null, "embeddingModel": null}`, and the
  embedding-stamp migration — wrote the whole row it re-read inside its transaction. Harper
  orders a transaction by its first read, so that full-row write could carry a row read before
  an owner edit and revert the edit, even though the edit's own `PUT` had answered 200. The
  re-embed now writes only `embedding`, `embeddingModel` and `updatedAt`.
