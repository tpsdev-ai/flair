- **Claude Code can now save a continuity record just before a compaction and show it first when the session continues or restarts.**
  The new `flair-precompact` binary in `@tpsdev-ai/flair-mcp` is a `PreCompact` hook. It reads the end
  of the transcript (at most 1 MiB and 2,000 lines) and copies out, with no model call, the standing
  instructions a fixed word heuristic finds in the turns the transcript labels as user turns (once the
  harness markup it recognizes is removed), the open tasks, the last five file edits and shell-command
  descriptions (never the commands), and the last assistant message's text blocks, joined and cut to
  300 characters. Strings in the record that match its credential patterns (listed, with their limits,
  in `docs/claude-code.md`), including a whole Authorization-style value after `Authorization:`,
  `Bearer` or `Basic`, are replaced with `[redacted]` before the record is stored and again before it
  is shown (a task status that redaction would change is shown as `open` instead); a secret that
  matches no pattern is kept as written, and the record is at most 2,000 characters. When the
  transcript's end holds something to record and the write succeeds, it is stored with the agent's own
  key as one private, ephemeral memory in the session's continuity journal; a later run for the same
  session and trigger within 5 minutes of that record's first write, whether it repeats the compaction
  or handles a second one of the same kind, updates that record instead of adding one (two runs at the
  same moment can each add one). `flair-session-start` now puts the record at the top of its context
  after a compaction, and after a restart when the local marker file still names the previous
  session's record, ahead of the bootstrap context, as quoted data: between fixed begin and end lines,
  with every line prefixed, so no line of the record's text can forge the end line or start with a
  role marker such as `System:`. The text itself stays untrusted: formatting cannot guarantee that a
  model disregards an instruction written inside the quote. Once it has started, every path the hook
  handles ends in exit 0, so it does not block compaction (the documented command's `|| true` covers a
  launcher that fails first); when Flair is unreachable or slow, or one of its own files is refused,
  it shows one short warning. Its time budget (`FLAIR_PRECOMPACT_TIMEOUT_MS`, default 5000 ms) starts
  before it reads its input; when it passes, the hook stops waiting on asynchronous work and exits
  once its output drains (at most one more second). It cannot interrupt synchronous work such as the
  Flair client's read of the agent's key file (the hook entry's Claude Code `timeout` is the outer
  bound). It checks the size of the transcript, its continuity state file and its marker file before
  reading them; the key-file read is outside those caps. It is opt-in and wired by hand: `flair hook
  install` does not write the entry, and `docs/claude-code.md` gives the `settings.json` snippet and
  the heuristic's limits.

  (Closes #2069)
