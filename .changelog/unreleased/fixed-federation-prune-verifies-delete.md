- **`flair federation instance prune` verifies each delete, so it never prints a row it did not remove.**

  Harper answers a `delete` with HTTP 200 and reports the ids it removed in
  `deleted_hashes`, naming an id it did NOT remove in `skipped_hashes` — the same
  contract `updateInstanceRole` already checks. `deleteInstanceRow` took the
  status alone as success, so a skipped row was still reported as deleted: the
  operator read "deleted" for a row that was still there, and the instance kept
  two identities. The delete result is now checked, and a skipped id is an error
  naming what the server skipped instead of a line claiming a deletion.

  (Refs #1883)
