- **The federation receiver reports refusals for validated unique keys and awaits submitted commits.**

  `POST /FederationSync` rejects malformed or duplicate keys before merging.
  Successful batch responses carry `refused` entries with closed `SkipReason`
  values. The write-back deadline refuses work before commit submission after
  rollback; submitted commits are awaited. An unconfirmed submitted outcome
  returns `503 sync_merge_outcome_unknown`.
