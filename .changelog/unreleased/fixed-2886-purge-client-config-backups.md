- **`flair uninstall --purge` removes the client-config `.bak` copies that still carried Flair's entry.**
  Unwiring each client snapshots its config to a sibling `<config>.bak`, and purge now deletes a
  snapshot that carries Flair's entry — `mcpServers.flair`, pi's `npm:@tpsdev-ai/pi-flair` source or a
  path inside the pi-flair package, or Codex's `[mcp_servers.flair]` header — listing the path under
  `Removed`. A pre-existing snapshot is held across the unwiring write, so its bytes (or, for a symlink,
  the link itself) survive. A snapshot with no Flair entry may be the user's own copy and stays
  byte-identical. A snapshot that cannot be read, and a JSON snapshot that cannot be parsed, are listed
  under `Not checked` and left in place; so is a pi snapshot whose entry only contains the string
  `pi-flair` without naming Flair's package. Purging a home other than the process `HOME` resolves pi
  under that home and reports that `PI_CODING_AGENT_DIR` was ignored. The run then exits non-zero. Plain
  `flair uninstall` keeps every backup.
