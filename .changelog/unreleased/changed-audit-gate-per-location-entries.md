- **The dependency audit gate accepts several allowlist entries for one advisory, for example one per install source or dependency chain.**
  An entry is identified by its `ghsa`, `package`, `sources` and `introducedBy`. At most one
  entry per advisory and package may name `bun` or the root npm-install observation. When an
  advisory has several entries, each entry that names another consumer install must have an
  `introducedBy` chain that resolves to one node there, a reported node blocks unless exactly one
  entry's chain resolves to it, and an entry that covers no reported location in a source it
  names is stale even when another entry for the same advisory is in use. An entry classed
  `vendor-pinned` that names the `bun` source blocks, because bun.lock resolves through the root
  `overrides`.
