- **The dependency audit gate accepts several allowlist entries for one advisory, for example one per install source or dependency chain.**
  An entry is identified by its `ghsa`, `package`, `sources` and `introducedBy`. At most one
  entry per advisory and package may name `bun` or the root npm-install observation. When an
  advisory has several entries, each entry that names another consumer install must have an
  `introducedBy` chain that resolves to one node there, a reported node blocks unless exactly one
  entry's chain resolves to it, and an entry that covers no reported location in a source it
  names is stale even when another entry for the same advisory is in use. An entry classed
  `vendor-pinned` that names the `bun` source blocks, because bun.lock resolves through the root
  `overrides`.
  Every required entry field must be a string (and `sources` a non-empty array): an object or array
  in, say, `introducedBy` is refused rather than read as present. If a later diagnostic fails on a
  malformed entry, the gate still prints every problem it had recorded before exiting non-zero.
