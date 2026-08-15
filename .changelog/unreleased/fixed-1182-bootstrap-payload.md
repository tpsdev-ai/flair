- **The `/mcp` `bootstrap` tool now returns its full payload, not just the
  server version.** The wrapper spread an un-awaited Promise into its response,
  so every computed field — the resolved agentId, the scope descriptor, the
  soul map, the memories and predicted containers, and the opt-in abstention
  verdict — was dropped and a connector caller saw only `{ flairVersion }`.
  Awaiting the response restores the complete payload.
