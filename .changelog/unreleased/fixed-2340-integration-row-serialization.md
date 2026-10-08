- **An Integration write that names a stored row re-reads the committed row before it commits.**
  When that row is no longer the row this attempt read, the write aborts and is
  retried from the committed row (bounded).
