- **Flair refuses to serve with more than one worker thread, because two replay
  guards are per worker.** `THREADS_COUNT=1` is the shipped setting, but Linux
  picks several workers when nothing pins the count, and under more than one
  worker the agent-auth and federation replay checks no longer bound replay: a
  signed request is no longer accepted at most once within its window. With
  `server.workerCount > 1` every worker now logs one named error, answers every
  route other than `/Health` with one named 503 before any authentication or
  table access, and `flair doctor` fails a `worker threads` check. `/Health`
  answers 503 and reports the refusal. Workers stay up in the refused state;
  nothing throws during boot. One worker is unchanged: no new log line and
  `/Health` is identical.

  > **Heads-up:** if the instance logs the multi-worker refusal, set
  > `THREADS_COUNT=1` and restart Flair to serve again.
  > `FLAIR_MULTI_WORKER_UNSAFE=1` is the only escape hatch — the instance
  > serves, but the refusal stays logged and `/Health` stays non-OK — and it is
  > never set by any flair launch path.
