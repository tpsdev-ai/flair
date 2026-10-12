- **The flair-client accepts host-source fields on memory writes and returns bound sources on non-admin agent reads (flair#1940).**

  `memory.write()` gains the optional `hostSource`, `hostSourceScope` and
  `sessionId` fields, forwarded only when supplied. For non-admin agent reads,
  `search()`, `get()` and `list()` return a bound host source when one exists,
  or `withheld` when the reader cannot see it. Read results carry stored
  `sessionId` and `provenance` when present; `search()` also carries the record's
  `author`. A `hostSource` is the writer's unverified claim
  about an external source, stored with the writer's authenticated agent id;
  Flair does not verify it.
