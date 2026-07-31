- **`docs/quickstart.md` no longer claims one install gives you three things.**
  It said `npm install -g @tpsdev-ai/flair` provides `flair`, `flair-mcp` and the
  client library; the package declares one binary and neither of the other two as
  a dependency.

  Both the quickstart and the README now separate the two things called "MCP":
  the server's own `/mcp` endpoint, which ships inside the package but registers
  no route unless `FLAIR_MCP_OAUTH` and a public issuer are set, and the stdio
  adapter `@tpsdev-ai/flair-mcp`, which is what MCP clients are actually wired to
  and is fetched on demand via `npx` rather than installed globally.
