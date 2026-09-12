- **Federation verify no longer reports FAIL when a probe cannot authenticate.** Unverifiable peers (401/403, unreachable) exit 0 with a warning; a reachable peer missing the canary still fails (flair#823).

  `flair federation verify` used to treat an auth-gated read-back, a 60s wait shorter than the sync cadence, and leftover revoked rows as "peer did not see the memory." It now pushes the canary itself (bring-up has no daemon yet), skips revoked peers, and reuses the #988 couldn't-check-≠-failed split. The canary is written `visibility: shared` so the push actually federates it.

  > **Heads-up:** exit 0 now includes "checked peers have the memory, some peers unverifiable." Exit 1 still means a reachable peer was verified wrong. A 401 is not a sync failure.
