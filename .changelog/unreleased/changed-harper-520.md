- **Harper is now 5.2.0, and its SQL engine default changed.** Flair pinned Harper 5.1.22;
  5.2.0 is the first stable release of the 5.2 line. Two consequences worth knowing. First,
  **`sql.engine` now defaults to `auto`** rather than `legacy`: queries are planned by
  Harper's Resource-API engine and fall back to the legacy AlaSQL path only for shapes it
  does not support. Set `sql.engine: legacy` to restore the previous behaviour, or `new` to
  disable the fallback and surface unsupported shapes as errors. Second, this carries a
  storage read fix that 5.1.22 did not have: in the `@harperfast/rocksdb-js` version that
  range permitted, a column-family override was honoured on the synchronous block-cache
  attempt but dropped in the async worker, so every table after the first in a request was
  read through a foreign column family — cache hits correct, **cache misses silently
  returning not-found**, worst immediately after a restart and healing as traffic warmed
  the cache.
