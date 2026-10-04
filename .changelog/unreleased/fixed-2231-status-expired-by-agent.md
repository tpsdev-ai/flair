- **`flair status`: the expired-`validTo` warning is grouped by agent** (#2231).
  The warning names at most five agents, counts remaining named agents, and
  reports rows with no agent id separately.
  It marks an installed nightly scheduler whose plist or service names each agent.
  Linux installation requires both timer and service; orphans report their path.
  Scheduler file read failures report unknown with the path and error code.
  The active-state probe reports not active when systemctl cannot reach a user
  session bus, and unknown when the probe command cannot run or does not
  complete in time.
  The breakdown is included in `flair status --json` when expired rows exist.
