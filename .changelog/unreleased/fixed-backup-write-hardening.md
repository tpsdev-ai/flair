- **The `.bak` backup now writes every byte and never leaks its staging temp.**

  `backupBytesTo` staged the backup through a `wx` 0600 temp but used a single
  `writeSync` — a short write would rename a truncated file into place as a
  false recovery copy — and it unlinked the temp only when the RENAME failed, so
  a `write`/`fsync` failure left partial token bytes on disk. It now reuses the
  primitive's `writeAllSync` loop and unlinks the temp on every failure path.

  (Refs #1778)
