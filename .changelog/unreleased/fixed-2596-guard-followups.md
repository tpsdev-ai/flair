- **Boot graph-heal and the dedup sweep consult the embedding-space guard, and the REM runner records its named state (#2596).**

  When a store's model stamps are not verified uniform in the current space, the
  graph-heal migration now skips its canary cosine comparison and logs the guard
  state, so the migration reads as unverified this boot and retries on a later
  one. The `/MemoryDedupStats` sweep re-checks the guard immediately before it
  persists, so a write carrying a foreign stamp during the sweep leaves the stat
  file untouched and names the state instead of recording counts. The REM runner
  records that response — null counts plus the guard's named state — rather than
  logging an unexpected response shape.
