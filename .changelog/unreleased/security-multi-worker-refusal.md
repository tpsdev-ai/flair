- Flair returns a named 503 for non-health requests when Harper reports multiple workers without the unsafe opt-in or cannot read the worker count.
  The normal remedy is `THREADS_COUNT=1` and a restart; investigate a count that remains unreadable.
