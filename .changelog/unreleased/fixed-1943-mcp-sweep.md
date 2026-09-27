- **The MCP client guide, the flair-mcp README and the native-OAuth note describe what ships.**
  Client-wiring examples pass `--agent`; `flair agent add` is described as writing a raw 32-byte seed; the structured bootstrap payload is attributed to HTTP and native `/mcp`, with stdio returning a text block; a failed hook bootstrap is described as a stderr diagnostic plus an optional resume hint; read scope is described as own plus other agents' non-private records; and the native OAuth note describes the shipped configuration.

  (Refs #1943)
