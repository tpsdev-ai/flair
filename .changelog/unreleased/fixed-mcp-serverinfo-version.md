- **`/mcp` reports its real version.** The `initialize` response hardcoded
  `serverInfo.version` as `0.1.0`, which is the string a connecting client
  displays and the one someone reads while diagnosing an incident. It now comes
  from the package version.
