- **`flair hook install --harness codex` writes a Codex SessionStart hook.** Same
  `flair-session-start` command Claude Code already uses, merged into
  `~/.codex/hooks.json` (Codex's hook file — same JSON schema). `uninstall` /
  `status` take the same flag. `flair doctor` reports the Codex hook when
  Codex is detected; after install, trust the command with `/hooks`. Clients
  with no session-start hook get a documented AGENTS.md / GEMINI.md fallback
  in `docs/mcp-clients.md` so MCP wiring alone is not mistaken for done
  (flair#1148).
