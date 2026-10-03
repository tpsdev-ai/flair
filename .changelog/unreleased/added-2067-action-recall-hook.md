- **A PreToolUse hook adds your own triggered lessons as context for the next action.** `flair hook install --action-recall`
  wires a Claude Code `Bash` hook that reads a bounded, per-session cache of the agent's own lessons, refreshed at
  session start. Each lesson opts in with a `metadata.flairActionRecall` trigger. The hook emits only
  `hookSpecificOutput.additionalContext` and writes nothing, exiting 0, on any error or an unsupported, missing,
  corrupt or stale cache (flair#2067).
