- **The feed ingest/repair and both `lastReflected` stamps write under the per-id Memory lock shared with owner PUT and PATCH.**

  The ordinary (non-skill) write-back of `POST /FeedMemories` takes the target
  id's lock and commits before releasing it. An omitted id is generated; a
  caller-supplied id can contend. The skill branch returns before this lock;
  its conversion is deferred. The feed write is a foreground client write: a
  held id waits its budget and can answer `503 memory_busy`, with the caller id
  and nothing else; an id marked outcome-unknown answers
  `503 write_outcome_unknown`. The authored replacement and its committed-row
  confirmation are unchanged.

  The dedup expiry repair (`POST /FeedMemories` matching an ephemeral row with
  no expiry) takes the id's lock with one non-waiting acquisition, re-reads the
  committed row under it, and writes only `expiresAt`. A held id, an
  outcome-unknown marker or a store with no lock skips the repair and logs it;
  the response is the matched row, projected without its inline pointer fields
  and unrepaired. A later feed write repairs it only if the row still matches
  and still lacks an expiry.

  The `lastReflected` stamps — on a new row's `derivedFrom` sources and on the
  sources a reflection run read — take each source id's lock with one
  non-waiting acquisition, read the committed row under it, and write only
  `lastReflected`. A held source is skipped and logged; the stamp remains
  best-effort and never fails the request.

  Each converted writer reads the committed row under the lock and confirms the
  committed row before the release. When the committed row does not show the
  staged write, feed ingest answers `409 feed_write_unconfirmed` and the dedup
  repair answers `409 feed_dedup_target_changed`; the best-effort
  `lastReflected` stamps log a skip. The lock remains per process.
