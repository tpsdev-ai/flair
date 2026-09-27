- **A pointer commits with its Memory row, a partial PUT keeps a PRIVATE memory private, and an echoed pointer keeps a SHARED pointer shared.**
  The host pointer (`hostSource`) lives in its own `MemoryHostSource` table and is written
  with the request's transaction — a request's open one when there is one, and a created one
  when an internal caller has no request context — so the Memory row and its pointer commit
  together or not at all. A failed pointer write aborts that transaction and neither row
  commits; a failed pointer delete fails the Memory delete (real-Harper tests `t1`, `t2`,
  `c3`). A partial `PUT` that omits `visibility` carries the existing row's visibility into
  the written row, so a private memory is never silently widened (`p2`). An echo of the
  stored pointer keeps it (and its scope) unchanged ONLY when the writer is the stored
  pointer's author AND the value matches exactly, full URL included — a different query is a
  new value, not an echo. The pointer is cascaded away where its Memory row is deleted,
  expired or archived, all in one owned transaction; an orphan sweep re-checks inside the
  transaction before deleting. `MemoryHostSource` refuses every REST write verb for every
  caller (`r4-http`); a superuser Harper operation against the table (export, backup,
  reseed) is the operator path. Both federation directions apply the writers' declared
  attribute whitelist, so a dirty row cannot carry a pointer field either way (`f1-out`,
  `f1-in`).

  (Refs #1940)
