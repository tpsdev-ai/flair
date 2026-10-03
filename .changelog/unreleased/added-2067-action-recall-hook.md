- `flair hook install --action-recall` wires a Claude Code `Bash` PreToolUse hook and SessionStart refresh.
  Lessons opt in with `metadata.flairActionRecall` triggers. The hook emits only additional context;
  errors produce no output and exit 0 (flair#2067).
