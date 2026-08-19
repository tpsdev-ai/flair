- **`flair federation sync enable` and `flair rem nightly enable` now verify
  the job's FIRST RUN through the service manager before claiming success**
  (flair#1231). Previously the ✅ headline only required launchd/systemd to
  *accept* the job; two shipped defects (a scheduler shim whose exec bit is
  stripped by tarball extraction, and a log directory nothing ever created)
  both passed that check and silently killed every real run. Now: both shims
  run the CLI under `node <script>` (read permission suffices — no exec-bit
  dependency), with the node binary resolved to an absolute path at enable
  time so the shim performs zero PATH lookups at run time; enable creates
  `~/.flair/logs` (mode 0700 — the REM log carries memory content); and after
  a successful load, enable triggers the first run via the service manager
  (`launchctl kickstart` + exit-status poll on macOS, blocking
  `systemctl --user start` + status read on Linux) and refuses the success
  headline unless that run exited 0 — failures report the exit status, a
  stderr tail from the job's log, and the fix to apply. "Service manager
  unreachable" and "run still going after 12s" are reported as their own
  distinct states, never as success.
