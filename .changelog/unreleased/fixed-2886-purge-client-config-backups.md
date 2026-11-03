- **`flair uninstall --purge` removes the client-config `.bak` copies that still carry Flair's entry.**
  Unwiring a client snapshots an existing config to a sibling `<config>.bak` when that copy is
  written. Purge moves a pre-existing snapshot onto a free hold path before the unwiring write and
  restores it before the sweep. When that hold and restore succeed, purge deletes a snapshot that
  carries Flair's entry — `mcpServers.flair`, pi's `npm:@tpsdev-ai/pi-flair` source or a path inside
  the pi-flair package, or Codex's `[mcp_servers.flair]` header — listing the path under `Removed`;
  a snapshot with no Flair entry may be the user's own copy and stays byte-identical, and its bytes
  (or, for a symlink, the link itself) survive the unwiring write. A snapshot that cannot be read,
  and a JSON snapshot that cannot be parsed, are listed under `Not checked` and left in place; so is
  a pi snapshot whose entry only contains the string `pi-flair` without naming Flair's package, when
  no Flair-owned entry is also present. Purging a home other than the resolved caller home resolves
  pi under that home; a `PI_CODING_AGENT_DIR` override is then ignored and reported. A run with
  failed or unverified leftovers exits non-zero. Plain `flair uninstall` keeps every backup.
