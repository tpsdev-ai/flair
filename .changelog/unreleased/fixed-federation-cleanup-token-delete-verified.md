- **The pairing-cleanup sweep confirms each expired-token delete from Harper's result.**

  Harper answers a `delete` with HTTP 200 and names the records it removed in
  `deleted_hashes` and any it did NOT remove in `skipped_hashes`. The sweep logs
  "deleted expired token" only when the result names the token as removed and
  not as skipped. Otherwise it logs that the record was NOT deleted, naming the
  first 8 characters of the token id, and the next tick retries it: the record
  is still in the table, so it is still a candidate. The same rule confirms the
  deletes of `flair federation instance prune` and the role update of
  `flair init --remote`.
  (`test/unit/federation-cleanup.test.ts`, `test/unit/instance-identity-row.test.ts`)
