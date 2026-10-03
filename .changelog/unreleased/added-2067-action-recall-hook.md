- `flair hook install --action-recall` copies a version-matched Claude Code Bash recall hook to Flair-owned storage.
  SessionStart caches own lessons with `metadata.flairActionRecall` triggers. Install probes the copied command;
  status probes a detected entry, while absence is informational. Uninstall removes the provisioned runtime.
  Invalid client response caps are rejected (flair#2067).
