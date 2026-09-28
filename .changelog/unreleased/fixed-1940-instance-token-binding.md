- **The host pointer joins on a server-stamped row incarnation token, so a stale pointer is never returned and cleanup is hygiene.**
  The named application create paths stamp a local `instanceToken`; existing legacy rows may have none. Memory's REST write paths remove client-supplied `instanceToken` and `provenance`. The named update paths retain a stored token when their existing-row read succeeds. The `MemoryHostSource` row
  stores the row's `memoryInstanceToken`, and the join returns a pointer (or `"withheld"`) only when
  `memoryId`, `authorId === agentId`, the incarnation token, and “not archived” all hold — so a
  deleted-and-recreated id, a re-owned row, and an archived row all show no pointer, with no cleanup
  required. `Memory.get()`, `Memory.search()` and `SemanticSearch` render pointers through the
  pointer helper. Other Memory projections, bootstrap included, do not render pointers in
  this slice. `originatorInstanceId` is handled in #1965.

  (Refs #1940)
