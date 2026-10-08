- **The `flair hook status` probe now signals the process group its command ran in.**
  A command that timed out used to leave its descendants — an `npx`/`npm exec`
  helper, say — running after `status` returned. Outside Windows the probe now
  runs the command in its own process group and, on the timeout path and after
  a normal exit, signals that group (SIGTERM, then SIGKILL after a short bounded
  grace). A descendant that moved itself into another process group or session
  is not signalled. When the probe cannot confirm that the group ended, or the
  command writes more than 1 MiB to stdout or stderr, the probe reports that
  reason and does not report the hook as working (flair#2385).
