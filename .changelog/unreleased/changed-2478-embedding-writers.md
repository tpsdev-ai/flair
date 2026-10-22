- **Embedding writers write under the per-id Memory lock shared with owner PUT and PATCH.**

  The HTTP re-embed (`PATCH /Memory/<id>` with both embedding fields `null`)
  holds the id's lock from its first read through its commit, under its own
  hold-warning phase name, `patch-reembed`. As before, it writes only the
  embedding fields (`embedding`, `embeddingModel`, `embeddedContentHash`,
  `updatedAt`), and gives a legacy row that has no `instanceToken` one in the
  same update. Once one of its attempts has committed and no read-back has
  shown the write, every exit of the same request other than a later
  verified success (a provider timeout, a refusal, a 409 for a changed row,
  a thrown error such as the write-stamp notifier's after a commit) answers
  `503 write_outcome_unknown` and fences the id, instead of an answer that
  says nothing was written; a retry that finds the row gone answers 404.

  The embedding-stamp migration's `.content`-suffix fallback computes its
  vector first, then takes the id's lock with one non-waiting acquisition
  per attempt (a retry acquires it again). On a held id, an id with an
  unresolved write outcome, or a store with no lock, that attempt writes
  nothing and is logged, and the row is left uncounted; the next scan decides
  whether it is still stale. After an earlier attempt for the same row
  committed unconfirmed, the log says the outcome is unknown.
  Holding the lock, it writes only if the committed row is the one it
  embedded, and reads the committed row back before the release. A re-embed
  request the migration delegates over HTTP that is refused `503`
  (`memory_busy`, `write_outcome_unknown`, `memory_provider_timeout`) is logged
  and the row is left uncounted; `write_outcome_unknown` can mean the request's
  own write could not be read back and may have committed.

  The embedding backfill that follows a successful HTTP Memory write signed
  by a verified Ed25519 agent (a Basic-admin write returns from the auth
  middleware before that step and starts none) also computes its vector
  first and takes the id's lock with one non-waiting acquisition per
  attempt (a retry acquires it again); a held id or an id with an
  unresolved write outcome is skipped and logged, and after an earlier
  unconfirmed attempt of the same backfill the log says the outcome is
  unconfirmed. Holding the lock, it
  writes only if the committed row's text is the text it embedded, and it
  reads the committed row back, text included, before the release. If that
  read-back is readable and finds the text changed, its retry compares the
  row's stored vector with the vector it staged, within a float32
  tolerance, instead of the stored text hash, which a row with an empty
  owner does not have; on a match beside the changed text it re-embeds the
  current text, within at most 3 attempts. An unreadable read-back, or the
  attempts exhausted, leaves the outcome logged as unconfirmed. The
  migration's fallback does the same, leaving such a row uncounted for the
  next scan (#2478).
