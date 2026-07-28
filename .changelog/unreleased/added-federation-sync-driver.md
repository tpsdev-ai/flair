- **`flair federation sync enable` — federation finally has an automatic driver.** Until now
  `flair federation sync` was one-shot and `flair federation watch` was a foreground loop that
  died with its terminal, so a freshly paired spoke synced exactly once and then silently stopped
  — which reads as a broken pairing rather than as a missing scheduler. `enable` installs a
  periodic one-shot on the platform scheduler (launchd `StartInterval` on macOS, a systemd user
  timer on Linux), with `disable` and `status` to match, mirroring `flair rem nightly`. Default
  interval 300s, `--interval` to change it, first sync runs immediately. `federation watch` is
  unchanged and remains the right tool for interactive debugging.

  The scheduler never writes a password into a unit file: it stores the *path* passed to
  `--admin-pass-file` (defaulting to `~/.flair/admin-pass` when present) and the CLI reads it at
  run time, refusing any file that is not owner-only.
