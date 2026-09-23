- **`flair doctor --fix --dry-run` now prints MCP re-pin lines in the real run's format.**

  The would-re-pin line prefixed `@tpsdev-ai/flair-mcp@` to an old pin that was
  already the full pinned spec, so the package printed twice; and a HOLD line
  omitted the client label the real run prints, so with several behind clients
  the dry-run output did not say which client each hold applied to. The dry-run
  lines now match the real run: `(<oldPin> -> <newPin>)` for a would-re-pin, and
  `HOLD <client>: <reason>` for a hold.

  (Refs #1834)
