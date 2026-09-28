- **A non-admin Memory read ignores the caller's `select`/`property` and returns the authorized, gated pointer-projected row (slice 1 of #1940).**
  The auth middleware drops `select(...)` and `property` from a REST request URL before Harper
  parses it, and `Memory.get`/`Memory.search` drop them for a direct contextual read, keeping
  conditions, operator, sort, limit and offset exactly as sent. The read is answered on the same
  id, or the same conditions under the same read scope, so each stored row goes through the gated
  pointer join, which renders a pointer only from a bound `MemoryHostSource` row. A selected
  collection response MAY include additional stored fields, including an embedding when one is
  present, not only the named ones. Admin and trusted internal reads are unchanged.

  (Refs #1940)
