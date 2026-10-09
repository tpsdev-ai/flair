- **The capture flush bounds its asynchronous setup and each write with one deadline (flair#2321).**

  Flushes use a separate lock. A capture during network writes is spooled; append-lock contention can refuse it after the bounded wait.
  The final spool rewrite is synchronous.
  A spool record whose agent
  id is not the installed agent's is not flushed. The 10 ms p95 hot-path budget in
  `scripts/capture-latency.mjs` is a manual measurement: no CI lane runs it.
