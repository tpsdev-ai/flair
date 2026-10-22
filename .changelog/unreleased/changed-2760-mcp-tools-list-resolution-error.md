- **The embedded `/mcp` handler's `tools/list` answers a caller whose principal cannot be resolved with an error.**
  When the token subject's credential or principal cannot be read, or its
  mapping is refused (for example, the principal is deactivated), `tools/list`
  returns the same JSON-RPC error as a `tools/call` of a known tool by that
  caller, and no tool list. A subject with no mapping still gets a tool list
  (flair#2760).
