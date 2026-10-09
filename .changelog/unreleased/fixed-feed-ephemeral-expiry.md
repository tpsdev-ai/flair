- **Feed-written ephemeral memories without an explicit expiry now get the tier TTL.**
  This includes an existing ephemeral row without an expiry when a feed write deduplicates onto it.
  Ordinary Memory PUT/PATCH handle tier transitions; AgentSeed stamps ephemeral expiry.
  Federation stamps missing ephemeral expiry on the receiver clock when the incoming row wins last-write-wins
  and refuses malformed or out-of-bound ephemeral dates (flair#2274).
