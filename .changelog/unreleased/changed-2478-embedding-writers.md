- **Embedding writers write under the per-id Memory lock shared with owner PUT and PATCH.**

  The HTTP re-embed (`PATCH /Memory/<id>` with both embedding fields `null`)
  holds the id's lock from its first read through its commit, under its own
  hold-warning phase name, `patch-reembed`. As before, it writes only the
  embedding fields (`embedding`, `embeddingModel`, `embeddedContentHash`,
  `updatedAt`), and gives a legacy row that has no `instanceToken` one in the
  same update.

  The embedding-stamp migration's `.content`-suffix fallback computes its
  vector first, then takes the id's lock once. A held id, an id with an
  unresolved write outcome, or a store with no lock is logged, written nothing
  and left uncounted; the next scan decides whether the row is still stale.
  Holding the lock, it writes only if the committed row is the one it
  embedded, and reads the committed row back before the release. A re-embed
  request the migration delegates over HTTP that is refused `503`
  (`memory_busy`, `write_outcome_unknown`, `memory_provider_timeout`) is logged
  and the row is left uncounted; `write_outcome_unknown` can mean the request's
  own write could not be read back and may have committed.

  The embedding backfill that follows a successful HTTP Memory write signed
  by a verified Ed25519 agent (a Basic-admin write returns from the auth
  middleware before that step and starts none) also computes its vector
  first and takes the id's lock
  once; a held id or an id with an unresolved write outcome is skipped and
  logged. Holding the lock, it writes only if the committed row's text is the
  text it embedded, and it reads the committed row back, text included, before
  the release. If the vector it committed no longer matches the row's text, its
  retry recognises that vector by the vector itself and re-embeds the current
  text, also for a row with an empty owner, which stores no text hash; the
  migration's fallback does the same (#2478).
