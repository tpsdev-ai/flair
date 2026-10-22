- **The feed ingest/repair and both `lastReflected` stamps write under the per-id Memory lock shared with owner PUT and PATCH.**

  `POST /FeedMemories` takes the target id's lock around its write-back and
  commits before releasing it. A pure create uses a fresh id, where the lock is
  uncontended. The feed write is a foreground client write: a held id (or one
  whose last write's outcome is unresolved) waits its budget and answers
  `503 memory_busy`, with the caller id and nothing else. The authored
  replacement and its committed-row confirmation are unchanged.

  The dedup expiry repair (`POST /FeedMemories` matching an ephemeral row with
  no expiry) takes the id's lock with one non-waiting acquisition, re-reads the
  committed row under it, and writes only `expiresAt`. A held id, an
  outcome-unknown marker or a store with no lock skips the repair and logs it;
  the matched row is returned unchanged and the next feed write retries.

  The `lastReflected` stamps — on a new row's `derivedFrom` sources and on the
  sources a reflection run read — take each source id's lock with one
  non-waiting acquisition, read the committed row under it, and write only
  `lastReflected`. A held source is skipped and logged; the stamp remains
  best-effort and never fails the request.

  Each converted writer reads the committed row under the lock and confirms the
  committed row before the release; a committed row that does not show the
  staged write is reported as skipped. The lock remains per process.
