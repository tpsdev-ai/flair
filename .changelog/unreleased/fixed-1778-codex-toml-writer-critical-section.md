- **Codex's `~/.codex/config.toml` writers are now one locked, atomic critical section.**

  `_wireCodex` and `_unwireCodex` (reached by `flair init` codex,
  `doctor --fix`, the owned-pin refresh and `uninstall --purge`) wrote the file
  in place with a raw `writeFileSync` — truncate then write. A reader (Codex
  itself) could see a half-written config, and a crash mid-write could leave it
  partial. Both now observe → decide on the IN-LOCK TEXT (decoded UTF-8, not the
  JSON parser) → write via `withConfigCriticalSection` (temp + `fsync` + atomic
  rename), with a 0600 `<path>.bak` of the in-lock bytes. The three former write
  arms (append / replace / create) are ONE decision with three outcomes, and the
  never-lower pin guard (`decidePinWrite`) now runs on the in-lock text. The
  pure TOML helpers are unchanged, so the bytes written are exactly today's, and
  every report line is byte-identical. `hook-install.ts`'s
  `readCodexConfigToml` stays read-only.

  > **Heads-up (behaviour change):** config.toml writes now replace the file's
  > inode instead of writing in place, so a reader holding an open fd keeps the
  > OLD contents until it reopens (Codex re-reads at startup); a 0600
  > `<path>.bak` is written on every mutating call where the file EXISTS —
  > including a no-op (already wired) or a held pin — overwritten from the
  > IN-LOCK bytes; and a config.toml CREATED by Flair now lands **0600** (the
  > primitive's staging mode), where the old raw create arm got the umask
  > default (~0644). A newly CREATED file takes no backup (there are no prior
  > bytes).

  > **Heads-up (threat boundary, unchanged):** this serializes cooperative Flair
  > writers. Codex itself also writes config.toml (`codex features enable/
  > disable` persist to `$CODEX_HOME/config.toml`); an external write landing
  > during Flair's decide/replace is still overwritten — a tracked design issue,
  > out of scope here.

  (Refs #1778)
