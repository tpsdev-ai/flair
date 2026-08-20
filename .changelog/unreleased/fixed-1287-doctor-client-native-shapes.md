- `flair doctor` no longer false-negatives a working MCP setup written by a
  client's own tooling (#1287). Root cause: doctor demanded `FLAIR_URL` in the
  wired block, while flair-client treats it as optional (falling back to its
  built-in default) and the documented `claude mcp add` command sets only
  `FLAIR_AGENT_ID` — so a stock setup that followed our own docs was reported
  as "no Flair MCP server configured" and told to run a fix it didn't need.
  Doctor's requirement now matches flair-client's actual contract: agent id
  required, URL optional. A URL-less block reports as configured with an
  explicit "FLAIR_URL not set — flair-mcp defaults to <url>" note, and
  reachability/registration are verified against that default. The Codex TOML
  scanner gets the same contract plus support for the inline `env = { ... }`
  table form Codex itself preserves. Detection is now pinned by literal
  client-native fixtures for all five registry clients (captured from
  `claude mcp add` / `gemini mcp add`, codex source, Cursor and Antigravity
  docs), each with a drift-detection assertion that the fixture is not
  byte-identical to our own wire output — a fixture regenerated from our
  generator can no longer masquerade as client coverage.
