- **Connector-conformance suite for the `/mcp` tools.** Every shipped `/mcp`
  tool now has a declarative consumer contract (shape + semantic invariants),
  co-located with its definition, driven against a seeded store through the tool's
  real implementation. The suite codifies the historical connector-bug classes —
  counted-equals-delivered, charged-equals-shipped, dedup-by-content-signature,
  self-describing empty containers, the same-estimator `tokenEstimate` check, and
  no leaked internal fields — and a fail-closed completeness check fails the build
  if a new tool ships without a contract.
