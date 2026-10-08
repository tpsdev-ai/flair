- **One agent-ID rule now guards every path that creates or renames an Agent (#2359).**
  The rule `AgentSeed` enforced (`^[a-zA-Z0-9_-]{1,64}$`) now lives in one shared
  helper imported by both the CLI and the server. The Agent resource's REST
  writes, `flair agent add`, the JIT-principal writers and the federation merge
  each refuse a non-matching id with the named error `invalid_agent_id` before
  anything is written. `flair doctor` reports stored agent ids outside the rule
  and rewrites nothing automatically.
