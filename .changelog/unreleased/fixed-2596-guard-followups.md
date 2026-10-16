- **Boot graph-heal and the dedup sweep consult the embedding-space guard, and the REM runner records its named state (#2596).**

  Graph-heal skips its canary cosine comparison unless the guard snapshot is
  uniform. Failed re-verification halts the migration without recording success;
  a later migration cycle can retry. `/MemoryDedupStats` preserves the existing
  stat file and returns the guard state when its pre-persist recheck refuses.
  REM records guard
  refusals with null counts and a known refusal state.
