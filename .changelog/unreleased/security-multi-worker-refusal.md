- **Flair enters a refusal state when Harper reports more than one worker thread.**
  The guard reads `server.workerCount` first, then
  `server.config.threads.count` only if the first read fails or is not a
  positive integer. An unreadable count is also refused. Requests other than
  `/Health` and `/health` receive a named 503 before dispatch. `/Health` reports
  the refusal, and `flair doctor` fails its `worker threads` check. Workers stay
  up and log the condition; one-worker responses remain unchanged.

  > **Heads-up:** set `THREADS_COUNT=1` and restart Flair to serve again.
