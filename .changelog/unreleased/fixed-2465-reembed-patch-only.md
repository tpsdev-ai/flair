- **A background re-embed writes only the embedding fields and confirms the committed row
  after staging (#2465).** `Memory.patch()`'s re-embed branch — reached by `flair reembed`, a
  direct `PATCH /Memory/<id>` whose body is `{"embedding": null, "embeddingModel": null}`, and
  the embedding-stamp migration's `.content`-suffix fallback — wrote the whole row it re-read
  inside its transaction. Harper orders a transaction by its first read, so that full-row write
  could carry a row read before an owner edit and revert the edit, even though the edit's own
  `PUT` had answered 200. Both re-embed paths now write only `embedding`, `embeddingModel` and
  `updatedAt`, and each STAGES that write and then confirms the committed row is still the one
  it read: a row gone or replaced since is refused with the named `stored_row_changed` and the
  staged write discarded. Harper has no compare-and-set, so a change committed after that
  confirm and before the commit is not seen. The migration's fallback writes through the raw
  table handle because the by-id PATCH path cannot address a `.content`-suffixed id.
