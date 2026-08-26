- **`flair doctor` detects MCP clients from their config file, not just the CLI binary** (flair#1417).
  Cursor is a GUI app whose `cursor` shell command is opt-in; a working
  install with `~/.cursor/mcp.json` and no `cursor` on `PATH` was reported
  as absent, so `doctor --fix` skipped it. Detection now treats a known
  config path as presence for every `kind: mcp` client that already has
  one (Claude Code, Codex, Gemini, Cursor, Antigravity). Per-client
  `detect` stays the exception.
