- **`flair backup` compares collection IDs with inventories whose cardinality matches exact storage counts.** Closes #2228.

  Count or ID mismatches and unavailable counts refuse publication. Explicit
  `--port` pairs with its derived ops port unless an ops target overrides it.
  HTTP failure messages omit response bodies.

  > **Heads-up:** Concurrent deletes can cause a count mismatch; pause writers and maintenance, then retry the backup.
