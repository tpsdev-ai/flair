- **Public plugin `mcp.json` no longer pins `@tpsdev-ai/flair-mcp`.**
  `packages/cursor-flair/mcp.json` now uses unpinned `npx -y @tpsdev-ai/flair-mcp`,
  so directory listings resolve latest instead of rotting at a stale version
  (the listing had 0.44.13 while npm latest was 0.46.0). CI fails if a public
  plugin `mcp.json` re-pins a version or dist-tag. (#1307)
