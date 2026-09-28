- **A reindex and a federated merge no longer erase a memory's provenance, and cleanup no longer marks a surviving memory deleted.**
  The `_reindex` admin path restores the STORED `provenance` after the server-stamped-field strip, so a corpus-wide reindex is byte-for-byte. A federated Memory merge restores the provenance its merge actually selected (the inbound value for a new row, the merge's LWW choice for an update) instead of dropping it. The Memory delete notifies the lexical index only after the shared Memory-and-pointer write commits, a failing pointer delete no longer removes the surviving row from a warmed BM25 index, the non-admin Memory search streams its pointer join in fixed-size chunks, and one orphan-cleanup failure no longer aborts the whole sweep.

  (Refs #1940)
