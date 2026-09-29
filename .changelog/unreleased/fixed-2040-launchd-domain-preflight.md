- **Launchd handoffs check before stopping anything, report what they could not verify, and claim launchd only when proven (flair#2040).**
  Over an ssh session the per-user GUI launchd domain can be unreachable
  (`launchctl print gui/<uid>` → `125: Domain does not support specified
  action`). `flair doctor --fix` used to clean-stop a healthy direct-spawned
  instance and only then fail to load the job, leaving Flair down. `flair init`
  printed "Launchd service registered ✓" for a plist it never loaded.

  Before `doctor --fix` stops the instance or unloads a job, it checks:
  - that the GUI domain answers and the job is not disabled there (read-only
    `launchctl print` and `print-disabled`);
  - the engine;
  - that existing plist and config files are readable;
  - which jobs are loaded;
  - which process serves the instance (or, when nothing is identified, that the
    port is free);
  - the credential;
  - the plist it would install: every path exists, the launcher and node are
    executable, and `plutil -lint` ran and accepted it.

  An answer it cannot get counts as a failed check. It then refuses — non-zero,
  never "fixed" — without stopping or unloading anything. The one file it can
  write before refusing is the 0600 admin-pass file, when it must provision that
  file from a credential proven against the running instance.

  The load uses commands that name the probed domain (`launchctl bootstrap`,
  `bootout` and `kickstart` against `gui/<uid>`), not `load`, `unload` and
  `start`. Those act on whatever domain launchctl infers for the calling
  process. If a step fails after the stop, doctor tries to unload the new job
  and checks that it is gone, puts the plist and config files back
  byte-for-byte, and tries to restart the instance directly. The result reports
  each attempt's outcome. It also says when the state could not be established,
  for example a job that could not be shown unloaded, in which case nothing is
  started.

  `flair init` retires a legacy `ai.tpsdev.flair` job only behind the same
  checks. Init retires a non-serving legacy job directly and replaces a serving
  legacy job through the guarded handoff; it removes the legacy plist only after
  confirming the job is unloaded. If it
  cannot be shown gone, init keeps that plist, puts back the plist it had just
  written, reports the uncertainty and exits non-zero. When the job does serve
  the instance, init tries the guarded replacement and a restore. When that
  cannot be established, it refuses. Otherwise init writes the plist and says
  Flair is running directly, not launchd-managed. The move off a legacy label
  made by `flair start` (and the start legs of `restart`, `upgrade` and
  `snapshot`) runs `plutil -lint` on the replacement plist before it unloads
  anything, and refuses the move when the lint rejects it or cannot run.

  A refusal like that, or a plist whose paths no longer exist, has loaded and
  unloaded nothing, and the start paths then boot nothing out either: the
  legacy job and both plists are left as they are. Flair starts directly only
  when read-only `launchctl print` queries show no job for the instance loaded.
  When one is loaded, or its state cannot be read, the command starts nothing,
  names the job and the `launchctl bootout` remedy, and exits non-zero.

  `init`, `start` and `doctor` print a launchd check mark (including the
  legacy-migration lines) or "repaired" only when launchd's pid equals an
  identified serving pid. When the serving process cannot be identified, the
  result says so and claims nothing. After loading the job, `doctor --fix`
  waits, up to the 60-second startup budget, while launchd reports a pid for
  the job and its port does not answer (the connection is refused, or the
  probe cannot tell), even when `hdb.pid` already names that pid: Harper can
  write `hdb.pid` before it binds its port. "Repaired" also requires Flair's `/Health` to answer `ok`. A
  port that answers ends the wait and is judged at once; a job that never
  serves fails at the deadline, and the restore runs. After a failed load,
  `flair start`'s fallback names the reason instead of a raw
  `launchd start failed`, and starts directly only once the job is shown
  unloaded again; otherwise it reports the uncertainty and exits non-zero.
  `flair restart` still stops first: its start leg decides only whether Flair
  comes back under launchd or directly.

  The launchd launcher no longer starts a second instance on a data directory
  that a live process already serves (the pid in `hdb.pid`). It exits 0 before
  Harper loads anything, and launchd's KeepAlive retry may start Flair once that
  process has exited. This PID guard applies only to the macOS launchd
  launcher.

  > **Heads-up:** to hand a directly running instance to launchd, run
  > `flair doctor --fix` from a console (GUI) login session on the Mac. launchd
  > may also start the job at the next console login (the plist sets RunAtLoad),
  > provided the plist is valid and the job is enabled.

  (Closes #2040)
