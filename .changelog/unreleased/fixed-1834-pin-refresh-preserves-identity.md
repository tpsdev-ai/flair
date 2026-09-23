- **A pin refresh now changes only the pinned package argument, never a wired client's agent identity.**

  `flair upgrade`'s pin refresh and `flair doctor --fix`'s targeted re-pin used
  to rebuild each wired JSON MCP entry from a host-wide identity guess, rewriting
  every client's `FLAIR_AGENT_ID` (and `FLAIR_URL`, `type`, extra env keys and
  extra fields) — the 0.55.1 defect that pointed every wired client at whichever
  key sorted first. The refresh is now pin-only: it locates the single
  `@tpsdev-ai/flair-mcp` argument, advances just that array element, and leaves
  the rest of the entry deep-equal. Ambiguous shapes (a duplicated `flair` key or
  `FLAIR_AGENT_ID`, a bare-plus-pinned package, no identifiable package) and a pin
  the never-lower guard cannot prove safe are HELD with the bytes untouched. Codex
  (TOML) keeps its stale pin until its own pin-only writer lands.

  > **Heads-up:** a release that installs this fix runs the PREVIOUS version's
  > refresh one last time when upgraded with `flair upgrade`. Prefer
  > `npm i -g @tpsdev-ai/flair@<version>`, then `flair restart`, then
  > `flair doctor --fix`. Identities already corrupted by the old refresh cannot
  > be recovered.

  (Refs #1834)
