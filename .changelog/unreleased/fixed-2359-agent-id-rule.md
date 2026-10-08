- **One agent-ID rule now guards the paths that create an Agent (#2359).**
  The rule `AgentSeed` enforced (`^[a-zA-Z0-9_-]{1,64}$`) now lives in one shared
  helper imported by both the CLI and the server. `flair agent add`,
  `flair principal add`, `flair mcp grant`, `flair mcp enable`'s IdP
  provisioning, the Agent resource's REST writes, `AgentSeed` and the federation
  merge refuse an id outside the rule rather than store it; the resource,
  `AgentSeed` and the federation merge answer the named error
  `invalid_agent_id`. `flair doctor` reports stored agent ids outside the rule;
  it rewrites nothing.
