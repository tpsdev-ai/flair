- **`doctor --fix` preflights the launchd domain before it stops anything, and `init`/`start` stop claiming a load that never happened (flair#2040).**
  Over an ssh session the per-user GUI launchd domain is unreachable (`launchctl
  print gui/<uid>` → `125: Domain does not support specified action`). `flair
  doctor --fix` used to clean-stop the live instance first and only then fail to
  load the job, leaving Flair down until someone ran `flair start` — and `flair
  init` printed "Launchd service registered ✓" for a job that was written but
  never loaded (the plist has RunAtLoad, so it does load at the next console
  login, but nothing said so before).

  A new read-only preflight (`src/lib/launchd-domain-preflight.ts`) runs
  `launchctl print <domain>` BEFORE any stop. `doctor --fix` refuses (exits
  non-zero, counts an issue, never "fixed") when the domain is unavailable OR
  cannot be verified, with the actor, state and remedy: "the launchd GUI domain
  is unavailable from this session … the job loads at the next console login
  (RunAtLoad) — or run 'flair doctor --fix' from a console session, or reboot
  with auto-login. The running instance was left untouched." When the domain is
  available, adoption bounces and verifies exactly as before. `flair init` and
  `flair start` now verify the job is actually loaded (`launchctl print
  <domain>/<label>`) before printing a check mark; otherwise they say the plist
  was written and it loads at the next console login, with the reason, instead of
  a raw `launchctl start … failed`. Linux is unaffected: Flair's instance service
  is launchd-only, so the preflight is not-applicable there (the systemd user-bus
  condition on the scheduled-driver path is handled separately, flair#1107).

  (Closes #2040)
