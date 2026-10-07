- **`flair init` re-pins a stale SessionStart hook, and `flair hook status` reports it.**
  Both read the stale-pin finding `flair doctor` uses, which now takes the pin from the
  pinned span named by the hook's command.
  `flair hook status` reports a command naming a pin behind the installed CLI in red
  and exits 1. When `flair init` wires Claude Code or Codex, it re-pins that client's
  behind hook through the guarded re-pin helper, except under `--skip-hook`, or when the
  helper holds the pin or its write fails. A settings file with more than one hook
  command carrying `flair-session-start`, or a command that names a `flair-mcp` pin and
  has two or more `npx -y -p` spans or no matching span, is held: `flair init`
  leaves it as is and reports it, and `flair hook status` reports it.
