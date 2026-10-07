- **The capture flush bounds its asynchronous setup and each write with one deadline, and runs at most one flush per agent at a time (flair#2321).**

  The flush holds the per-agent lock for its whole run, so a second flush for the
  same agent returns `busy` at once; a lock left by a flush whose process died is
  reclaimed by the same stale rule the hot path uses. A flush that reaches its
  deadline stops writing and leaves whatever it did not write in the spool,
  including a record that belongs to another agent; the final spool rewrite is a
  synchronous local write that follows the last write. A spool record whose agent
  id is not the installed agent's is not flushed. The 10 ms p95 hot-path budget in
  `scripts/capture-latency.mjs` is a manual measurement: no CI lane runs it.
