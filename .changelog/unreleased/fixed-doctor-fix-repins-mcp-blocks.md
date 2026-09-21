- **`flair doctor --fix` now re-pins a behind MCP-client block, not just the SessionStart hook, through the one shared writer.**

  `flair doctor --fix` re-pinned the SessionStart hook but never the MCP-client
  block, so a pin behind the running CLI stayed a blocking failure whose remedy
  (`flair upgrade`) reports up-to-date in that state and acts on nothing. The
  fix routes the write through the ONE guarded writer the upgrade refresh
  already uses (`refreshOwnedPins`, now targetable per client), so #1485's "one
  source of truth" finally has a single FIXER too: behind => re-pinned (old ->
  new, one printed line per client), ahead/unknown => held, only wired clients.
  The remedy for a behind MCP pin is now `flair doctor --fix`.

  (Refs #1779, #1485, #1778)
