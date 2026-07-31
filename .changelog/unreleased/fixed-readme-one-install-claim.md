- **`docs/quickstart.md` no longer claims one install gives you three things.**
  It said `npm install -g @tpsdev-ai/flair` provides `flair`, `flair-mcp` and the
  client library; the package declares one binary and neither of the other two as
  a dependency. Both the quickstart and the README now say what is true: one
  install, one command, and the MCP adapter is fetched on demand by each client
  via `npx` rather than installed globally — which is the design, not a gap.
