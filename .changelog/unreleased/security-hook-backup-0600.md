- **The `<path>.bak` hook-config backup is now written 0600, never the umask default.**

  `backupBytesTo` used a bare `writeFileSync`, so under umask 022 a 0600 settings
  file holding a token produced a 0644 `<path>.bak` with the token bytes verbatim
  — on every mutating run, and (because the critical-section primitive backs up on
  every call that reaches the read) on a no-op run too. The backup is now written
  through a sibling temp opened `wx` 0600, fsynced, then renamed over `<path>.bak`,
  so the bytes are never world-readable even briefly and an existing 0644 `.bak`
  is tightened to 0600.

  > **Heads-up (behaviour change):** a `<path>.bak` created by an older release is
  > tightened from its current mode to 0600 on the next run that takes a backup.

  (Refs #1778)
