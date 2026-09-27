- **The host pointer joins on a server-stamped row incarnation token, so a stale pointer is never returned and cleanup is hygiene.**
  Each Memory row now carries `instanceToken`, a server-generated UUID stamped at first persist on
  every create path (post/put create, the feed, the seed, a federation receive of a new row),
  stripped from any client body on every writer, and preserved by every update path (put, patch,
  reindex, the feed update, the federation merge, supersede-close). The `MemoryHostSource` row
  stores the row's `memoryInstanceToken`, and the join returns a pointer (or `"withheld"`) only when
  `memoryId`, `authorId === agentId`, the incarnation token, and “not archived” all hold — so a
  deleted-and-recreated id, a re-owned row, and an archived row all show no pointer, with no cleanup
  required. `Memory.get()`, `Memory.search()` and `SemanticSearch` render pointers through the
  pointer helper. Other Memory projections, bootstrap included, do not render pointers in
  this slice. Memory's REST write paths remove `instanceToken` and `provenance` from the
  request body. `originatorInstanceId` is handled in #1965.

  (Refs #1940)
