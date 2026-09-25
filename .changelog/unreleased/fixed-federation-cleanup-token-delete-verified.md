- **The pairing-cleanup sweep confirms each expired-token delete from Harper's result.**

  Harper answers a `delete` with HTTP 200 and names the records it removed in
  `deleted_hashes` and any it did NOT remove in `skipped_hashes`. The sweep logs
  "deleted expired token" only when the result names the token as removed and
  not as skipped. Otherwise it logs that the delete was NOT confirmed, naming the
  first 8 characters of the token id; a record still in the table is still a
  candidate, so the next tick retries it. An error from the delete is logged
  with the token id cut to that prefix. The same rule confirms the
  deletes of `flair federation instance prune` and the role update of
  `flair init --remote`.
  (`test/unit/federation-cleanup.test.ts`, `test/unit/instance-identity-row.test.ts`)
