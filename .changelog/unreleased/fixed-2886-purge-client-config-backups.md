- **`flair uninstall --purge` removes a client-config `.bak` copy that carries Flair's entry.**
  Unwiring a client snapshots an existing config to a sibling `<config>.bak` when that copy is
  written. Purge moves a pre-existing snapshot into an exclusively created private hold directory
  before the unwiring write and restores it before the sweep; when the hold or restore fails, the
  client or its backup sweep is skipped and reported. When the hold and restore succeed, purge
  deletes a snapshot that carries Flair's entry — `mcpServers.flair`, a pi `packages` source or
  `extensions` entry that is Flair's own (`npm:@tpsdev-ai/pi-flair` or a local path inside the
  pi-flair package), or Codex's `[mcp_servers.flair]` header — listing the path under `Removed`;
  a snapshot with no Flair entry may be the user's own copy and stays byte-identical, and its bytes
  (or, for a symlink, the link itself) survive the unwiring write. When the hold and restore succeed
  and the scan runs, a snapshot that cannot be read, a JSON snapshot that cannot be parsed, and a pi
  snapshot whose only pi-flair mention in either field is not Flair's own are listed under
  `Not checked` and left in place; a failed hold or restore is reported under `Left (failed)`
  instead. Purging a home other than the resolved caller home resolves pi under that home; a
  `PI_CODING_AGENT_DIR` override is then ignored and reported. A run with failed or unverified
  leftovers exits non-zero. Plain `flair uninstall` keeps every backup.
