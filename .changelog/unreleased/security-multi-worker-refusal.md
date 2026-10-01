- **Flair refuses to serve with more than one worker thread, until the
  multi-worker readiness work lands.** `THREADS_COUNT=1` is the shipped setting,
  but Linux can select several workers when nothing pins the count, and more than
  one worker is not yet supported: a per-worker embedding engine and per-worker
  BM25 index copies today, with the in-process caches and rate limiters not yet
  enumerated, and the XAA token path's `jti` single-use record until #2073 routes
  it through the shared atomic check-and-record. With `server.workerCount > 1` —
  or a count that cannot be read — every worker now logs one named error, and the
  instance refuses before dispatch on every route Flair serves (its default chain
  and every `urlPath` mount it registers, mounted routes such as `/mcp`
  included), ahead of the method allowlist, with one named 503. `/Health` answers
  503 and reports the refusal, and `flair doctor` fails a `worker threads` check.
  Workers stay up in the refused state; nothing throws during boot. One worker is
  unchanged: no new log line and `/Health` is identical.

  > **Heads-up:** if the instance logs the multi-worker refusal, set
  > `THREADS_COUNT=1` and restart Flair to serve again.
  > `FLAIR_MULTI_WORKER_UNSAFE=1` is the only escape hatch — the instance
  > serves, the opt-in is still logged and `/Health` stays non-OK — and it is
  > never set by any flair launch path.
