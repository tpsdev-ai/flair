- **`flair init` re-pins a stale SessionStart hook, and `flair hook status` reports it.**
  Both read the stale-pin finding `flair doctor` uses, which now takes the pin from the
  hook's `npx -y -p` invocation instead of the first package string in the command.
  `flair hook status` reports a wired hook whose pin is behind the installed CLI in red
  and exits 1. When `flair init` wires Claude Code or Codex, it re-pins that client's
  behind hook through the guarded re-pin helper, except under `--skip-hook`, or when the
  helper holds the pin or its write fails. A settings file with more than one hook
  command carrying `flair-session-start`, or a command with two or more `npx -y -p`
  invocations or with a `flair-mcp` pin and no such invocation, is held: `flair init`
  leaves it as is and reports it, and `flair hook status` reports it.
