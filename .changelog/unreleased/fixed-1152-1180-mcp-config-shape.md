- **MCP OAuth config: derive `resource` from the issuer, env-reference
  `enabled` — deploys stop reverting the operator's choice** (#1152, #1180).
  The shipped `config.yaml` (and the block `flair mcp enable` writes) no
  longer sets `mcp.resource`: the old composite `${FLAIR_MCP_ISSUER}/mcp`
  never interpolated (component env expansion is whole-token-only), so every
  claude.ai connect bounced with `invalid_target`; absent, the component
  derives `<issuer>/mcp` at request time — identical to flair's in-process
  derivation. An operator needing a non-standard resource sets an explicit
  literal absolute URL. `mcp.enabled` is now the whole-token env reference
  `${FLAIR_MCP_OAUTH}` — the same flag flair's in-process `/mcp` route gates
  on — so enablement lives in the instance environment, not the packed file,
  and a re-packed deploy can no longer revert it. Requires
  `@harperfast/oauth` >= 2.5.0, enforced by a resolved-version assertion
  co-located with the behavioral boot-safety gate (below 2.5.0 an unresolved
  placeholder is a truthy string — fail-open; from 2.5.0 the component
  coerces only `"true"`/`"false"` and deletes anything else so the disabled
  default applies). The two readers accept different vocabularies — flair's
  strict flag takes 1/true/yes/on, the component only true/false — so
  `FLAIR_MCP_OAUTH=true` is the one end-to-end enable value and is what
  `flair mcp enable` now stages (previously `1`, which since the reshape
  would yield a guarded `/mcp` with no authorization server behind it);
  garbage values disable both sides. The asymmetry is documented at the
  config and flag sites and pinned by boot tests.
