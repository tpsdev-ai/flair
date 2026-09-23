- **A Codex TOML pin refresh now changes only the pinned package span, and `flair doctor --fix` re-pins a behind Codex block again.**

  PR-A1 made the JSON MCP pin refresh pin-only and left Codex (TOML) skipping
  until its own writer landed. This adds that writer: it locates the single
  `@tpsdev-ai/flair-mcp` span inside `[mcp_servers.flair]`'s single-line `args`
  element and replaces only that span — env tables, other args, other servers,
  comments, quoting and line endings stay byte-identical. Ambiguous shapes (a
  duplicated header, a package occurrence that is not the args element, an
  unmatched multiline-string fence before the header, an array-of-tables
  boundary) and a pin the never-lower guard cannot prove safe are HELD with the
  bytes untouched. `flair doctor --fix` re-pins a behind Codex block again, and
  its dry-run is derived from the same classification, so a target the real run
  would HOLD or skip never prints "Would re-pin".

  (Refs #1834)
