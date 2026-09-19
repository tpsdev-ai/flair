- **`flair hook status` reports verified delivery, not a bare wired check.**

  Status now distinguishes not configured, configured but delivery not
  verified (Codex untrusted / hooks disabled / agent-id drift / empty
  bootstrap), and configured+verified. `flair hook install --harness
  codex` names the Codex `/hooks` re-approval requirement. The Codex
  SessionStart payload stays the documented
  `hookSpecificOutput.additionalContext` contract. (Refs #1734)

  > **Heads-up:** a green hook status means delivery was verified, not
  > that a line exists in `hooks.json`. After install, re-approve the
  > hook in Codex (`/hooks`) before the next session.
