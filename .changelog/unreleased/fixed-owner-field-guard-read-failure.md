- **The owner-field guard refuses non-admin agent writes when its stored-row thunk fails.**

  A thrown or rejected guard thunk returns `owner_check_unavailable` (503;
  a numeric 4xx `statusCode` maps to 400). A resolved absent row is unchanged;
  admin/internal callers bypass the thunk.

  For addressed single-record HTTP PUT/PATCH, the test's injected initial
  row-load error returns Harper's own 500 before the resource runs (Harper's
  own id validation during that load can instead answer 400). Collection paths
  are outside this measurement; OrgEvent.post does not call this guard.
  Soul's earlier `resolveStoredRow` read returns `stored_row_lookup_failed`
  (500) on failure; this guard does not backstop that resolver read.
