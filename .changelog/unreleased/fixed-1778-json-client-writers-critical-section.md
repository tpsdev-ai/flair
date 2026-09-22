- **Every writer of the four JSON client-MCP config files is now one locked, identity-checked critical section — and `flair init` no longer writes `~/.claude.json` itself.**

  `~/.claude.json` (Claude Code), `~/.gemini/settings.json` (Gemini),
  `~/.cursor/mcp.json` (Cursor) and `~/.gemini/config/mcp_config.json`
  (Antigravity) are read-modify-write and were written in place with no lock.
  Two writers racing on one of them both read the same bytes and the second
  write silently discarded the first.

  `wireJsonMcp` and `unwireJsonMcp` now observe → decide on the IN-LOCK bytes
  (via `parseSettingsBytes`) → write via `withConfigCriticalSection`, with a
  0600 `<path>.bak` from the hardened `backupBytesTo`, and their pin guard runs
  on the in-lock parse. The parent directory is created outside the section.
  Report lines are byte-identical.

  `flair init`'s Claude Code wiring used to build `~/.claude.json` with its own
  inline read-modify-write (`os.homedir()`, a different entry shape, no trailing
  newline). It now DELEGATES to the shared writer, which returns a STRUCTURED
  outcome (created / refreshed / held / refused / already-present / fallback
  snippet) that init renders its existing lines from, keeping the FLAIR_CLIENT
  label and the guard's entry label. Both writers of the file now emit ONE
  shape.

  > **Heads-up (behaviour change):** the JSON writers take a 0600 `<path>.bak`
  > on every mutating call — including a no-op or a held pin — overwriting the
  > single sibling `.bak` from the IN-LOCK bytes.

  > **Heads-up (byte change on ~/.claude.json):** `flair init` now writes a
  > trailing newline (it wrote none) and KEEPS `type: "stdio"` in the entry (the
  > shared builder owns it, so neither writer strips it); an EMPTY
  > `~/.claude.json` now reads as `{}` and is wired, where the old
  > `JSON.parse("")` threw and downgraded the run to a printed snippet. The
  > Gemini, Cursor and Antigravity entry bytes are unchanged.

  (Refs #1778)
