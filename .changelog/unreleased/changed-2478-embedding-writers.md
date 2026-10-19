- **Embedding writers write under the per-id Memory lock shared with owner PUT and PATCH.**

  The HTTP re-embed (`PATCH /Memory/<id>` with both embedding fields `null`)
  holds the id's lock from its first read through its commit, under its own
  hold-warning phase name, `patch-reembed`. It writes only the embedding
  fields, as before.

  The embedding-stamp migration's `.content`-suffix fallback computes its
  vector first, then takes the id's lock once. A held id, an id with an
  unresolved write outcome, or a store with no lock leaves the row pending for
  a later scan and is logged. Holding the lock, it writes only if the committed
  row is the one it embedded, and reads the committed row back before the
  release. A re-embed request the migration delegates over HTTP that is refused
  `503` (`memory_busy`, `write_outcome_unknown`, `memory_provider_timeout`) is
  logged and the row stays pending (#2478).
