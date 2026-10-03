- **`flair status`: the expired-`validTo` warning is grouped by agent** (#2231).
  The warning names at most five agents, counts the remainder, and marks whether
  local scheduler files name each agent. Scheduler probe errors report unknown
  with the path and error code; systemd uses the service's `FLAIR_AGENT_ID`.
  The breakdown is included in `flair status --json`.
