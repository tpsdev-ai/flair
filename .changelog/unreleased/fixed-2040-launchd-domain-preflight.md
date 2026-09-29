- **`doctor --fix` and `init` check launchd before stopping anything and restore on failure; `start` claims launchd only after verifying it (flair#2040).**
  Over an ssh session the per-user GUI launchd domain can be unreachable
  (`launchctl print gui/<uid>` → `125: Domain does not support specified
  action`). `flair doctor --fix` used to clean-stop a healthy direct-spawned
  instance and only then fail to load the job, leaving Flair down, and `flair
  init` printed "Launchd service registered ✓" for a plist it never loaded.

  `doctor --fix` now checks everything it can before it stops anything: that the
  GUI domain answers and the job is not disabled there (read-only `launchctl
  print` and `print-disabled`), the engine and the credential, and the plist it
  would install (every path exists, the launcher and node are executable,
  `plutil -lint` accepts it). If a check fails it refuses — non-zero, never
  "fixed" — and the running instance is untouched. The load uses commands that
  name the probed domain (`launchctl bootstrap`, `bootout` and `kickstart`
  against `gui/<uid>`) instead of `load`, `unload` and `start`, which act on the
  domain launchctl infers for the calling process. If anything fails after the
  stop, doctor unloads the new job, puts the plist and config back, restarts the
  instance directly and says so ("running directly, NOT under launchd").

  `flair init` retires a legacy `ai.tpsdev.flair` job only behind the same
  checks; when that job is the process serving the instance, init loads and
  verifies the replacement and restores the legacy job if that fails. Otherwise
  init writes the plist and says Flair is running directly, not launchd-managed;
  the check mark appears only when launchd is verified to run the serving
  process. `flair start` checks the same way, prints `✅ Flair started
  (launchd-managed …)` only after verifying that launchd's pid is the serving
  pid, and a direct-start fallback names the reason and says "running directly,
  NOT launchd-managed" instead of a raw `launchd start failed`.

  The launchd launcher no longer starts a second instance on a data directory
  that a live process already serves (the pid in `hdb.pid`): it exits 0 before
  Harper loads anything, and launchd's KeepAlive retry starts Flair once that
  process has exited. Linux is unchanged: Flair's instance service is
  launchd-only.

  > **Heads-up:** to hand a directly running instance to launchd, run
  > `flair doctor --fix` from a console (GUI) login session on the Mac. launchd
  > may also start the job at the next console login (the plist sets RunAtLoad),
  > provided the plist is valid and the job is enabled.

  (Closes #2040)
