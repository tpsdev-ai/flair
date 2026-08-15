- **`flair upgrade` no longer reports a correctly-wired `flair-mcp` as "not
  detected".** It used to probe `flair-mcp` as a global npm install, but
  `flair-mcp` is zero-install via `npx` and is never installed globally — so a
  correctly-wired machine was told it was missing, with an `npm install -g`
  remedy that does nothing. Upgrade now detects `flair-mcp` by its actual wiring
  (the pinned version in a wired MCP client config, or the presence of the Flair
  SessionStart hook) and shows that version against the latest. "Missing" now
  means not wired anywhere; the remedy for a wired-but-behind or unwired
  `flair-mcp` is `flair doctor --fix`, never a global install.
