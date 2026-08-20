- **`flair doctor` now reports scheduled-driver liveness** (flair#1278). A new
  "Scheduled drivers" section reports, for each background scheduler
  (federation sync, REM nightly): installed, genuinely loaded per the service
  manager, and how the last run ended — read through `launchctl print` /
  `systemctl --user show`, reusing the flair#1231/#1282 exit-status parsers.
  Neither of #1231's fleet incidents (launchd spawn error 209 from a missing
  log directory, exit 126 from a stripped exec bit) was visible in doctor —
  driver health only surfaced in `flair federation sync status` /
  `flair rem nightly status`, commands an operator has to think to run. A
  last-run failure renders loud with the named failure class, what is
  happening (the schedule fires; the runs die), and the remedy (the job's
  stderr log + the scheduler's status command), and counts as a doctor issue.
  A scheduler that is not enabled renders as informational "not enabled" —
  never the pass marker, never the fail marker, never an issue. One trap
  encoded on the way: a systemd unit that has never completed a run reports
  `ExecMainStatus=0, Result=success` (property defaults), so the exit
  properties are only believed once `ExecMainExitTimestampMonotonic` proves a
  run actually finished — "never ran" must not render as "last run
  succeeded".
