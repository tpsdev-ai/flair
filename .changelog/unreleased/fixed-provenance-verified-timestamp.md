- **`provenance.verified.timestamp` is now stamped from the server clock, not the caller's `createdAt`.**
  Every field under `verified` is server-derived: `verified.timestamp` — and
  `verified.receivedAt` — is the server's write instant, taken from a single
  clock read per write. The caller's `createdAt` remains the writer's claim on
  the record and is recorded, sanitized like the other claims, under
  `provenance.claimed.createdAt`; the written row's own `createdAt` still
  carries the claim unchanged.

  Rows written before this release keep their stored provenance unchanged: their
  `verified.timestamp` is whatever the caller's `createdAt` was at the time (it
  may equal, precede, or follow the true write time) and there is no
  `claimed.createdAt`; rows written before that field existed also lack
  `receivedAt`. The server-stamped rule applies to writes from this release on.

  (Closes #1960)
