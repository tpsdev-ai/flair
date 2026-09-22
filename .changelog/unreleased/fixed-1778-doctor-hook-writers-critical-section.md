- **The four `flair doctor` hook-file writers now share the same locked critical section, so every writer of the hook settings file is race-free.**

  An earlier slice (`src/lib/config-critical-section.ts`) put the five
  `src/hook-install.ts` writers onto one observe → decide → write critical
  section, but the four `src/doctor-client.ts` writers that also write
  `~/.claude/settings.json` / `~/.codex/hooks.json` — doctor `--fix`'s
  continuity install and removal, the SessionStart hook add, and the legacy
  SessionStart command repair — still wrote the file in place with no lock. A
  migrated writer and a raw one racing on it could read a torn file and clobber
  the single `<path>.bak` with it. All four now go through
  `withConfigCriticalSection`: each decides on the IN-LOCK bytes, backs up those
  bytes before deciding, and writes via temp + `fsync` + atomic rename.

  The bytes-level helpers (`parseSettingsBytes`, `encodeConfig`,
  `backupBytesTo` and the `hookBackupPath` convention) moved to a shared leaf,
  `src/lib/settings-bytes.ts`, imported by both modules so they cannot drift.
  `flair hook install` is byte-for-byte unchanged, and the doctor writers keep
  their exact user-visible lines (fixed / already-present / held / `--skip-hook`).

  > **Heads-up (behaviour change):** the four doctor writers now take a backup on
  > every mutating run — including a no-op or a held pin — overwriting the single
  > `<path>.bak` from the IN-LOCK bytes, matching `flair hook install`. A newly
  > created settings file is written `0600` (temp + rename), where a raw write
  > previously created it with the default mode.

  (Refs #1778)
