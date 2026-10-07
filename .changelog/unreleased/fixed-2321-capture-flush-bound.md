- **The capture flush is bounded by one deadline and runs at most one flush per agent at a time (flair#2321).**

  A flush that reaches its deadline stops and leaves whatever it did not write in
  the spool; a second flush for the same agent returns while one is in progress,
  and a marker left by a flush whose process exited is taken over. A spool record
  whose agent id is not the installed agent's is not flushed. The 10 ms p95
  hot-path budget in `scripts/capture-latency.mjs` is a manual measurement: no CI
  lane runs it.
