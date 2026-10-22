- **A federated Memory merge and the batch reindex take the per-id Memory write lock shared with owner PUT and PATCH.**

  `POST /FederationSync` takes the id's lock, once and without waiting, before
  it merges an incoming Memory row. The merge writes only the fields it
  selected as an incremental update (a row carrying an attribute the merge
  strips is rewritten whole), decides on the committed row read under
  the lock, and confirms that row before its commit. A record whose lock is
  held, whose id carries an unresolved write outcome, or whose store has no
  lock writes nothing and is skipped as `merge_target_busy`: the skip is
  recorded in the sync log's skipped reasons, returned in the response's
  refused list, and classified retryable.

  `POST /MemoryReindex` takes each id's lock, once and without waiting, around
  its re-PUT. A row it cannot lock writes nothing and is counted and named in
  the result's `skipped` total and `skippedSamples`. The admin `_reindex` PUT
  runs under the same lock as an ordinary PUT and confirms the committed row
  after its own-committed write.
