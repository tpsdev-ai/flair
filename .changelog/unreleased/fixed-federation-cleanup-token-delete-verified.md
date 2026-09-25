- **The pairing-cleanup sweep verifies its expired-token delete, so a record Harper did not remove is never logged as deleted.**

  Harper answers a `delete` with HTTP 200 and reports the records it removed in
  `deleted_hashes`, naming a record it did NOT remove in `skipped_hashes` — the
  contract `deleteInstanceRow` and `updateInstanceRole` already verify. The
  sweep took the status alone as success, so a skipped record was logged as
  "deleted expired token" and the operator read a cleanup that had not happened.
  The delete result is verified now: a skipped record is logged as NOT deleted,
  naming the token id, and the next tick retries it — the record is still in the
  table, so it is still a candidate.
  (`test/unit/federation-cleanup.test.ts`)
