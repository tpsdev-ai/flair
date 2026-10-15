- **The federation receiver names refused and indeterminate keys.**

  `POST /FederationSync` rejects malformed or duplicate keys before merging.
  Per-record deadlines return `indeterminate: [{table, id}]`. Confirmed commits
  count as merged even when post-commit notes fail.
