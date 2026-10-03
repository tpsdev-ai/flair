- `flair hook install --action-recall` uses a version-matched local or npx-cached hook for Claude Code Bash recall.
  SessionStart caches own lessons with `metadata.flairActionRecall` triggers. Install and status require
  a local cache probe through the installed command; a failed probe makes status fail. Invalid client
  response caps are rejected (flair#2067).
