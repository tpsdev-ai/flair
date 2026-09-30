- **A pointer commits with its Memory row, and an echoed pointer keeps a SHARED pointer shared.**
  The host pointer (`hostSource`) lives in its own `MemoryHostSource` table and is written
  with the request's transaction — a request's open one when there is one, and a created one
  when an internal caller has no request context — so the Memory row and its pointer commit
  together or not at all. A failed pointer write aborts that transaction and neither row
  commits; a failed pointer delete fails the Memory delete (`t1`, `t2`,
  `c3`). A partial PUT carries the stored visibility it read at the start of the request, so
  a private memory is preserved sequentially (`p2`). An echo of the
  stored pointer keeps it (and its scope) unchanged ONLY when the writer is the stored
  pointer's author AND the value matches exactly, full URL included — a different query is a
  new value, not an echo. `Memory.delete` and maintenance expiry or age-based archival delete the pointer with their Memory operation. `MemoryArchive` basement/restore retains the pointer row; the join suppresses it while the Memory is archived. `Memory.delete` joins a request transaction when present; maintenance uses an owned transaction per item. An orphan sweep re-checks inside the
  transaction before deleting. `MemoryHostSource` refuses every REST write verb for every
  caller (`r4-http`); a superuser Harper operation against the table (export, backup,
  reseed) is the operator path. The outbound reader projects declared Memory attributes. The inbound merge removes undeclared attributes except the named bookkeeping fields (`f1-out`,
  `f1-in`).

  (Refs #1940)
