- **Claude Code can now save a continuity record just before a compaction and show it first when the session continues or restarts.**
  The new `flair-precompact` binary in `@tpsdev-ai/flair-mcp` is a `PreCompact` hook. It reads the end
  of the transcript (at most 1 MiB and 2,000 lines) and copies out, with no model call, the standing
  instructions found in your own turns by a fixed word heuristic, the open tasks, the last five file
  edits and shell-command descriptions (never the commands), and all the text of the last assistant
  message. Credential-shaped strings are replaced with `[redacted]` before anything is stored,
  including a whole Authorization-style value after `Authorization:`, `Bearer` or `Basic`, and the
  record is at most 2,000 characters. When the transcript's end holds something to record, it is
  written with the agent's own key as one private, ephemeral memory in the session's continuity
  journal; a rerun for the same compaction within 5 minutes updates that record instead of adding a
  second. `flair-session-start` now puts the record at the top of its context after a compaction, and
  after a restart when the previous session saved one, ahead of the bootstrap context, as quoted data:
  between fixed begin and end lines, with every line prefixed, so no line of transcript text can forge
  the end line or start with a role marker such as `System:`. The text itself stays untrusted:
  formatting cannot guarantee that a model disregards an instruction written inside the quote. The
  hook always exits 0, so it never blocks compaction; when Flair is unreachable or slow, or one of its
  own files is refused, it shows one short warning. Its time budget (`FLAIR_PRECOMPACT_TIMEOUT_MS`,
  default 5000 ms) starts before it reads its input; when it passes, the hook stops waiting on
  asynchronous work and exits once its output drains (at most one more second). It cannot interrupt
  synchronous work such as the Flair client's read of the agent's key file (the hook entry's Claude
  Code `timeout` is the outer bound). It checks the size of the transcript, its continuity state file
  and its marker file before reading them; the key-file read is outside those caps. It is opt-in and
  wired by hand: `flair hook install` does not write the entry, and `docs/claude-code.md` gives the
  `settings.json` snippet and the heuristic's limits.

  (Closes #2069)
