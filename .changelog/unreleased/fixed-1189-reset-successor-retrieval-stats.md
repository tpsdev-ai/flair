- **`memory_update` with `preserveHistory: true` no longer copies the superseded
  record's retrieval stats onto its successor.** The new supersedes-linked record
  now starts with `retrievalCount` at 0 and no `lastRetrieved`, instead of
  inheriting them from the record it replaces — which previously produced a
  successor whose `lastRetrieved` predated its own `createdAt` ("retrieved before
  it existed") and silently skewed recency- and usage-based ranking.
  `retrievalCount` and `lastRetrieved` are record-scoped and reset on succession;
  usage- and citation-ledger counters are unaffected.
