- **The bench harness now waits for Harper's RocksDB lock to be released before a restart, not just for the process to exit** (Refs #1440).
  Harper's detached child services hold the database `LOCK` (an `fcntl` record
  lock) for a beat after the parent exits, so a restart that only waited for
  exit could lose a ~1-in-500 race and fail the next `install` with
  "Resource temporarily unavailable". `stopHarper` now probes `/proc/locks`
  for the lock and waits (bounded, 5s) for it to clear when the install
  directory is kept for reuse. A genuinely-occupied database — a different live
  Harper on the same directory — still fails loudly, naming the lock; the wait
  never deletes or force-clears a `LOCK` file. On non-Linux platforms (where
  `/proc/locks` does not exist) the lock is unverifiable, so the harness falls
  back to the previous exit-wait behaviour and logs that the lock is
  unverifiable there rather than silently assuming it is free.
