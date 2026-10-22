- **`soul_set` is not in the embedded `/mcp` handler's `tools/list` for an agent.**
  That route authenticates callers with OAuth bearer tokens: a token subject
  mapped to an Agent acts as an agent principal, and the soul write policy's
  source-authorization step refuses an agent principal, so the call answers 403
  `soul_write_requires_operator`. The advertised list now omits `soul_set` for
  those callers. Listing resolves the caller the way a call does, except that it
  never JIT-provisions. An agent's soul is changed by the operator, on the
  agent's behalf (flair#2689).
