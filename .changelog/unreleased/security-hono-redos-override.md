- **`hono` pinned forward to `^4.12.34`** — GHSA-8j4g-w8fx-2239, a ReDoS in the CORS middleware via
  `Access-Control-Request-Headers`. Reaches us transitively through
  `@tpsdev-ai/flair-mcp › @modelcontextprotocol/sdk`, so it is not fixable by changing a direct
  dependency.

  This advisory was published **after** the previous override batch merged, which is worth recording:
  the dependency gate now goes red on main whenever a new advisory lands against something in the
  tree, and on 2026-08-03 that happened four times in one evening. The gate is telling the truth —
  main really is exposed until the pin lands — but "main is red" stops carrying information if it is
  the normal state. Worth a deliberate policy rather than a reflex.
