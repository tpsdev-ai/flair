- **`provenance.verified.timestamp` is now stamped from the server clock, not the caller's `createdAt`.**
  Every field under `verified` is server-derived: `verified.timestamp` — and
  `verified.receivedAt` — is the server's write instant, taken from a single
  clock read per write. The caller's `createdAt` remains the writer's claim on
  the record and is recorded, sanitized like the other claims, under
  `provenance.claimed.createdAt`; the written row's own `createdAt` still
  carries the claim unchanged.

  This holds on every LOCAL write path that stamps provenance: Memory `post()`,
  `put()` and a semantic `patch()`; Relationship `put()` and a semantic
  `patch()`; feed ingest; and the Soul/AgentSeed operators. A request body can
  never set — or carry forward — any field under `verified`: the writers strip a
  body-supplied `provenance` and re-derive it from the resolved auth and one
  server clock read. A semantic update (one that changes the record's content —
  `content`/`subject`/`summary` for Memory, `subject`/`predicate`/`object` for
  Relationships) re-stamps provenance; a metadata-only PATCH leaves the stored
  blob in place, because no new content was authored.

  Stored provenance is NOT rewritten. Rows written before this release keep
  their stored provenance unchanged: their `verified.timestamp` is whatever the
  caller's `createdAt` was at the time (it may equal, precede, or follow the
  true write time) and there is no `claimed.createdAt`; rows written before that
  field existed also lack `receivedAt`. Deliberate preservation cases: legacy
  rows, a metadata-only PATCH, the `_reindex` maintenance re-PUT (which keeps
  the stored bytes so a corpus-wide reindex stays byte-identical), and
  federation-synced rows (which keep the ORIGINATOR's stamped blob). The
  server-stamped rule applies to newly stamped local provenance from this
  release on.

  (Closes #1960)
