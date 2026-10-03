- **Unfiltered `flair backup` includes Memory/Soul rows whose owner has no Agent row and checks received totals against exact whole-table storage counts.** Closes #2228.

  Count or ID mismatches, unreadable rows and invalid owner IDs refuse publication;
  orphan-owner refusals report the row count. Filtered backups check selected owners.
  `--port` pairs with its derived ops port unless an ops target overrides it.
  HTTP failure messages omit response bodies.

  > **Heads-up:** Concurrent deletes can cause a count mismatch; pause writers and maintenance, then retry the backup.
