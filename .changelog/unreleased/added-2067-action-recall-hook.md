- `flair hook install --action-recall` wires a Claude Code `Bash` PreToolUse hook and SessionStart refresh.
  Lessons opt in with `metadata.flairActionRecall` triggers. Install and status require a local cache
  probe through the installed command. Invalid client response caps are rejected (flair#2067).
