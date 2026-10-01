- **Flair refuses to serve with more than one worker thread, until the
  multi-worker readiness work lands.** `THREADS_COUNT=1` is the shipped setting,
  but Linux can select several workers when nothing pins the count, and more than
  one worker is not yet supported: a per-worker embedding engine and per-worker
  BM25 index copies today, with the in-process caches and rate limiters not yet
  enumerated, and the XAA token path's `jti` single-use record until #2073 routes
  it through the shared atomic check-and-record. With more than one worker — the
  count read from `server.workerCount`, or Harper's effective configured count
  (`server.config.threads.count`) where reading the first fails or it is not a positive integer — every
  worker now logs one named error, and every request except `/Health` is refused before dispatch with
  one named 503: ahead of the method allowlist on the default chain, and ahead of
  the handler on each `urlPath` mount. a count with no positive integer from either read is
  UNKNOWN and refused, never read as one worker. `/Health` answers 503 and
  reports the refusal, and `flair doctor` fails a `worker threads` check.
  Workers stay up in the refused state; nothing throws during boot. One worker
  is unchanged: no new log line and `/Health` is identical.

  > **Heads-up:** if the instance logs the multi-worker refusal, set
  > `THREADS_COUNT=1` and restart Flair to serve again.
  > `FLAIR_MULTI_WORKER_UNSAFE=1` is the only escape hatch — the instance
  > serves, the opt-in is still logged and `/Health` stays non-OK — and it is
  > never set by a production Flair launch path.
