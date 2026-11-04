- **A federated Memory merge and the batch reindex take the per-id Memory write lock shared with owner PUT and PATCH.**

  `POST /FederationSync` builds the merged Memory row first, then takes the
  id's lock, once and without waiting, around its write. Under the lock it
  reads the row in its transaction and decides the write from it: for an
  existing row, the fields where the merged row differs from it, as an
  incremental update (a row carrying an attribute the merge strips is
  rewritten whole). The existing whole-row check then compares that row with
  the row the merge was built from, and the merge confirms that row before its
  commit. The lock does not serialize the merge against a PUT that joined
  another transaction, which can commit after that PUT releases the lock. A
  record whose lock is held, whose id carries an unresolved write outcome, or
  whose store has no lock writes nothing and is skipped as
  `merge_target_busy`: the skip is returned in the response's refused list and
  classified retryable, and the sync log row records it in its skipped reasons
  when that best-effort write succeeds.

  `POST /MemoryReindex` takes each id's lock, once and without waiting, around
  its re-PUT. A row it cannot lock writes nothing and is counted in the
  result's `skipped` total; `skippedSamples` lists up to five of those ids.
  The admin `_reindex` PUT runs under the same lock as an ordinary PUT and
  confirms the committed row after its own-committed write.
