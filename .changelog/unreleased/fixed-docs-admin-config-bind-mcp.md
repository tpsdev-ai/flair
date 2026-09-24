- **Docs now match the admin grant, the config file Flair actually reads, the HTTP bind, and the MCP tool list.**

  `flair principal promote` changes trust tier only (`endorsed`, `corroborated`,
  `unverified`). Admin is `flair principal add <id> --admin`. `~/.flair/config.yaml`
  examples list `port`, `opsPort`, `opsBind`, and `httpBind`. The HTTP listener
  follows `FLAIR_HTTP_BIND`, then `httpBind`, then loopback; on Linux that is
  resolved on every start, while on macOS the resolved bind is stored in the
  launchd job and a launchd-initiated restart reuses it without re-reading
  either. The MCP client page lists the sixteen tools `tools/list` advertises,
  including skills and `flair_catchup`.

  (Closes #1715, #1766, #1760; Refs #1780)
