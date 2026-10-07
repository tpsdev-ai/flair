- **Feed-written ephemeral memories without an explicit expiry now get the tier TTL.**
  Memory PUT/PATCH handle tier transitions; AgentSeed stamps ephemeral expiry.
  Federation keeps bounded valid dates, stamps missing dates on the receiver clock,
  and refuses malformed ephemeral dates (flair#2274).
