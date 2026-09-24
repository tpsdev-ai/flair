- **The OpenClaw memory plugin now makes every agent act only as itself, and refuses rather than guess.**

  Identity comes only from immutable host context (the tool/hook `ctx.agentId`). A
  configured `agentId` is an optional allow-list, never a fallback; env- and
  config-derived identity is gone. A missing or mismatched identity, a missing or
  unusable per-agent key, or a host version outside the tested set refuses — with zero
  outgoing requests, and never a Basic, unsigned, or inherited identity. Runtime
  workspace→Soul sync is removed; the plugin no longer takes the context-engine slot and
  no longer suppresses the host's native memory section; bootstrap is returned through
  `before_prompt_build` (never a non-existent `injectContext`); auto-capture is off by
  default and reads conversation content only through the permission-gated hooks.
  Registration is gated to the exact tested host versions (2026.8.1, 2026.9.6) and refuses
  when a gateway serves more than one agent under a single OS user.
