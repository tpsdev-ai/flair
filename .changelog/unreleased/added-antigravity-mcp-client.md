- **Added the Antigravity CLI (`agy`) as a wire-able MCP client.** `flair init`,
  `flair doctor` and the client registry now detect Antigravity and can write
  the pinned `flair-mcp` server into its MCP config at
  `~/.gemini/config/mcp_config.json` (a sibling of, and distinct from, Gemini
  CLI's `~/.gemini/settings.json`). Note: the end-to-end wiring has not yet been
  verified against a live `agy` — after wiring, restart Antigravity and confirm
  the flair tools appear.
