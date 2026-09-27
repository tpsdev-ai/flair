- **The session-start hook writes one line to stderr when a bootstrap fails, naming auth, timeout or unreachable, so the failure is no longer swallowed.**
  The hook catches every bootstrap error and still returns its inert no-op payload
  on stdout with the same exit code — a failure never blocks the session — but it
  now writes one line to STDERR: `flair session-start: bootstrap failed (<kind>);
  this session starts without Flair context. Next: run `flair doctor`, and check
  FLAIR_URL and this agent's key.` `<kind>` is `auth` (401/403), `timeout`, or
  `unreachable`, from what the error carries. The line never contains a key,
  token, password or Authorization value. The same path serves Claude Code and
  Codex; the Codex install keeps stderr visible, so the failure is now visible.

  (Refs #1943)
