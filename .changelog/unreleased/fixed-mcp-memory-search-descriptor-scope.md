- **`memory_search`'s `tools/list` description now states it covers other agents' non-private memories.**
  Every MCP client that lists tools sees the corrected read scope: the caller's own
  memories plus every other agent's non-private memories on the instance — no per-owner
  grant required.
