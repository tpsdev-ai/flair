- **A Codex TOML pin refresh no longer mistakes a sibling `[mcp_servers.flair*]` table for the Flair section.**

  The section-boundary matcher accepted any header beginning
  `[mcp_servers.flair`, so a sibling table such as `[mcp_servers.flair2]` was
  swallowed into the section. When the real `[mcp_servers.flair]` table carried
  no `args`, the sibling's args line became the section's and the refresh
  replaced the SIBLING's pin while reporting a Flair re-pin — a wrong-span
  write. The matcher now accepts only the exact header and its dotted subtables,
  so any other header ends the section and the ambiguous shape is HELD with the
  bytes untouched. "No identity configured" is also now decided from the
  section's active, non-empty `FLAIR_AGENT_ID` value, so a commented or empty
  assignment no longer reads as a configured identity.

  (Refs #1834)
