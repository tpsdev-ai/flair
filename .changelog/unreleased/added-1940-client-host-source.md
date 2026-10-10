- **The flair-client carries a host source on memory writes and returns it, with the author and session, on reads (flair#1940).**

  `memory.write()` gains the optional `hostSource`, `hostSourceScope` and
  `sessionId` fields, forwarded only when supplied; a write without them is
  byte-identical to before. `memory.search()`, `get()` and `list()` results
  carry the joined `hostSource` (or the server's `"withheld"` marker) and
  `sessionId`; `get()` and `list()` also carry `provenance`, and `search()`
  also carries the record's `author`. A `hostSource` is the writer's claim,
  not verified host authorship.
