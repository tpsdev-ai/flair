- **The JSON client-MCP config writers move onto the one critical section (partial).**

  `wireJsonMcp` and `unwireJsonMcp` (which serve ~/.claude.json, ~/.gemini/
  settings.json, ~/.cursor/mcp.json and ~/.gemini/config/mcp_config.json) wrote
  in place with no lock. They now observe → decide on the IN-LOCK bytes →
  write via `withConfigCriticalSection`, with a 0600 `.bak` from the hardened
  `backupBytesTo`. init's ~/.claude.json path now resolves through the same
  `resolveHome()` (os.homedir() is fixed at launch under Bun, so an in-process
  HOME override was ignored).

  > **Heads-up (behaviour change, pending):** the JSON writers take a 0600
  > `<path>.bak` on every mutating call, including a no-op or a held pin.

  (Refs #1778)
