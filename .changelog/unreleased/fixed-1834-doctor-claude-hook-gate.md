- **`flair doctor` now checks a wired Claude Code SessionStart hook whatever Claude Code's install state.**

  The Claude Code hook arm — and the client-integration section that contains
  it — was gated on Claude Code being detected/configured (its MCP block present
  in `~/.claude.json`). A project-scoped flair MCP setup (the server in a
  project's `.mcp.json`) with the SessionStart hook wired in
  `~/.claude/settings.json` therefore skipped the hook and silently missed a
  HOLD, the exact state this series exists to prevent. A hook file on disk is
  the wiring: the Claude Code SessionStart hook is now inspected whenever it is
  present, and a configured Claude Code with no hook still reports the missing
  hook and offers the fix.

  (Refs #1834)
