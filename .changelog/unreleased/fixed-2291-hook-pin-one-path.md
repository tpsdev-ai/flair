- **`flair init` re-pins a stale SessionStart hook, and `flair hook status` reports it.**
  Both now read the shared stale-pin finding and write through the guarded re-pin
  helper, so a hook left on an older `flair-mcp` version is refreshed on the next
  `flair init` instead of showing up as configured. The finding is the same one
  `flair doctor` already used.
