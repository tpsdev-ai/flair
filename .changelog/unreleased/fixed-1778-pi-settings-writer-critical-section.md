- **pi's `settings.json` writers are now one locked, atomic critical section — the last client-config sink (Refs #1778).**

  `_wirePi` and `_unwirePi` (reached by `flair init` pi and `flair uninstall
  --purge`; NOT by the upgrade/doctor pin refresh — `owned-pins` filters
  `kind === "mcp-client"` and pi is a native extension) wrote `$PI_CODING_AGENT_DIR/
  settings.json` (default `~/.pi/agent/settings.json`) in place with a raw
  `writeFileSync` — truncate then write. A reader (pi itself) could see a
  half-written settings file, and a crash mid-write could leave it partial. Both
  now observe → decide on the IN-LOCK bytes (`parseSettingsBytes`) → run the
  pi-flair pin guard (`decidePinWrite`) inside decide → write via
  `withConfigCriticalSection` (temp + `fsync` + atomic rename), with a 0600
  `<path>.bak` of the in-lock bytes. The pure helpers are unchanged, so the bytes
  written are exactly today's and every report line is byte-identical. With this
  slice **no raw config write remains anywhere in `src/install/clients.ts`** —
  the flair#1778 client-config migration is complete.

  > **Heads-up (behaviour change):** settings.json writes now replace the file's
  > inode instead of writing in place, so a reader holding an open fd keeps the
  > OLD contents until it reopens (pi re-reads at startup); a 0600
  > `<path>.bak` is written on every mutating call where the file EXISTS —
  > including a no-op (already wired) or a held pin — overwritten from the
  > IN-LOCK bytes; and a settings.json CREATED by Flair lands **0600** (the
  > primitive's staging mode), where the old raw create arm got the umask
  > default (~0644). A newly CREATED file takes no backup.

  > **Heads-up (threat boundary, unchanged):** this serializes cooperative Flair
  > writers. pi also writes its own settings; an external write landing during
  > Flair's decide/replace is still overwritten (a tracked design issue, out of
  > scope here). An orphaned lock left by a crash blocks later writes until it
  > is removed by hand (a later writer REFUSES by name) — crash-only provable
  > reclaim is tracked separately.

  (Refs #1778)
