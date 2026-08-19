- **Continuity slice 2: Claude Code hook adapter — ephemeral session journal
  with agent-pull resume.** New `flair-continuity-capture` binary
  (@tpsdev-ai/flair-mcp) journals working state on PostToolUse/Stop as
  ephemeral+private memories tagged `adk:continuity:<sessionId>`, under a
  strict capture discipline: mutating tools only (Write/Edit/NotebookEdit/
  Bash), Bash description-only (never the command string), file paths only
  (never content/diffs), Stop as a hard 400-char excerpt of assistant-chosen
  prose, malformed hook JSON journals nothing. `flair-session-start` grows the
  resume path: pointer-file fast path with an agentId-wide fallback
  disambiguated by processUUID, expired rows excluded, at most one boot hint
  line and never journal content. Fail-open throughout — Flair down or a
  guard refusal never blocks the turn or boot; compaction never rotates the
  session. Opt-in by installation: `flair hook install --continuity` /
  `flair doctor --fix`; doctor reports installed / not-enabled / stale-form,
  with a symmetric removal path. (flair#1257)
