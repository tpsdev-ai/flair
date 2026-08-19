- **MemoryMaintenance expires only ephemeral rows.** The nightly / REM
  maintenance pass previously deleted any memory whose `expiresAt` was in
  the past, including persistent and other non-ephemeral rows that had
  acquired an expiry (bug, import, API misuse). The docstring already
  scoped expiry to the ephemeral tier; the delete predicate now matches.
  Missing or unexpected durability is treated as non-ephemeral, so durable
  rows are not silently reaped. (flair#1265)
