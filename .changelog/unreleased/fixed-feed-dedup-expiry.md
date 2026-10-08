- **A deduplicated ephemeral feed row with no expiry now gets the tier TTL.**
  When the feed's content-hash deduplication returns a stored row instead of
  writing a new one, an ephemeral row that carries no expiry is stamped with the
  tier expiry through the shared rule. A row that already has an expiry, and a
  durable row, are left as they are (flair#2358).
