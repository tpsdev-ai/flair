- **Claude Code can now save a continuity record just before a compaction and show it first when the session continues or restarts.**
  The new `flair-precompact` binary in `@tpsdev-ai/flair-mcp` is a `PreCompact` hook. It reads the
  end of the transcript (at most 1 MiB and 2,000 lines) and copies out, with no model call, the
  standing instructions found in your own turns by a fixed word heuristic, the open tasks, the last
  file edits and shell-command descriptions (never the commands), and the last assistant message.
  Credential-shaped strings are replaced with `[redacted]` before anything is stored, and the record
  is at most 2,000 characters. It is written with the agent's own key as one private, ephemeral
  memory in the session's continuity journal; a rerun for the same compaction within 5 minutes
  updates that record instead of adding a second. `flair-session-start` now puts the record at the
  top of its context after a compaction, and after a restart when the previous session saved one,
  ahead of the bootstrap context. The hook always exits 0, so it never blocks compaction; when Flair
  is unreachable or slow it shows one short warning. Its time budget covers the whole process
  (`FLAIR_PRECOMPACT_TIMEOUT_MS`, default 5000 ms). It is opt-in and wired by hand:
  `flair hook install` does not write the entry, and `docs/claude-code.md` gives the `settings.json`
  snippet and the heuristic's limits.

  (Closes #2069)
