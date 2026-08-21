- **Connector principal mapping: distinct identities formalized, with the
  two-identity integration test (flair#1280).** An OAuth `/mcp` connector's
  token subject resolves to whatever Agent its `Credential(kind:"idp")`
  mapping names — deliberately NOT constrained to be your CLI agent
  (per-purpose connector identities are the product pattern; same-identity is
  an explicit opt-in). What changed is legibility, not the model: `flair mcp
  enable`'s identity-mapping step now states the resulting `sub → Agent`
  mapping in as many words (plus the link remedy and the
  `bootstrap.agentId`/`scope` diagnostic), `flair agent add` notes that a
  connector is a distinct identity and prints the exact link command, and
  `docs/notes/mcp-oauth-model2.md` documents the linking flow — re-running
  `flair mcp enable --principal <agent> --idp-subject <sub>` re-points the
  existing `(provider, subject)` Credential — including the JIT
  `idpProvider: "mcp-oauth"` caveat. The contract is pinned end-to-end by
  `test/integration/mcp-connector-principal-mapping.test.ts`, which drives the
  real `mcpHandler`/`resolveAgentFromSub` (no hand-built principal contexts)
  against a real store with two registered identities: cross-principal reads
  see org-non-private rows and never private ones (404-never-403 by id),
  bootstrap self-describes the resolved agent, and linking makes the connector
  see exactly what the linked agent sees.
