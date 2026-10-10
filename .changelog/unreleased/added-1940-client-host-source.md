- **The flair-client can carry a host source on a memory write and returns it, with the author, session and provenance, on reads (flair#1940).**

  `memory.write()` gains the optional `hostSource`, `hostSourceScope` and
  `sessionId` fields, forwarded only when supplied; a write without them is
  byte-identical to before. `memory.search()`, `get()` and `list()` results
  carry the joined `hostSource` (or the server's `"withheld"` marker),
  `sessionId` and `provenance`, and `search()` carries the record's `author`. A
  `hostSource` is the writer's claim, not verified host authorship.
