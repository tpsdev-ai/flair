- **SessionStart hook now pins `@tpsdev-ai/flair-mcp` the same way `flair init` pins client MCP configs.** `flair hook install`, `flair init`, and `flair doctor --fix` (when adding a missing hook) write `npx -y -p @tpsdev-ai/flair-mcp@<cli-version> flair-session-start` (flair#1143). A wired hook no longer self-updates to whatever was just published.

  This is the #907 supply-chain posture applied to the other user-local npx path — the same package, every session. Public plugin `mcp.json` stays unpinned (flair#1308) so directory listings do not freeze on a shipped version; that is a catalog file, not a machine we just wired.

  `flair hook status` still treats a pre-#1143 unpinned `-p` invocation as the correct shape. Re-run `flair hook install` to advance it to the running CLI's pin. A stale hook pin no longer shadows a client MCP pin, so `flair upgrade`'s client-config refresh can still clear an outdated flair-mcp finding.
