- **`soul_set` is not in the embedded `/mcp` handler's `tools/list` for an agent.**
  That route authenticates OAuth bearer tokens, which act as agent
  principals; the soul write policy refuses those principals, so the call
  answers 403 `soul_write_requires_operator`. The advertised list now matches
  the call, and the tool is listed only for a caller the policy admits. An
  agent's soul is changed by the operator (flair#2689).
