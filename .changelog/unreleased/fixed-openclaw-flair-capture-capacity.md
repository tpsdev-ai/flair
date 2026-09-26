- **The capture caps fail closed instead of breaking a guarantee.**

  Four follow-ups to the per-run capture state (flair#1884 round 3). At capacity,
  capture is now SKIPPED with a one-time log line, never satisfied by evicting
  something whose eviction breaks retirement or abort. (1) The retired/aborted
  run tombstone is kept at least `tombstoneMinAgeMs` (1 hour); the cap evicts
  only tombstones older than that, and a set full of younger entries refuses a
  new run (`capture-capacity: tombstones`) rather than re-admit a late callback.
  (2) The live-state cap never evicts a state with a write in flight; when every
  state is in flight a new run is refused (`capture-capacity: live-states`).
  (3) The tombstone gates ADMISSION only — an abort acts on any state still in
  the map, so a run idle-retired with a write in flight is still aborted and its
  late result discarded. (4) The client's combined abort signal now returns a
  cleanup that removes both listeners, and the request calls it on every path;
  a caller's long-lived signal no longer gains a listener per request.

  (Refs #1751)
