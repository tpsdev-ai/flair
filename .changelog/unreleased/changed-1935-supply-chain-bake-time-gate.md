- **The supply-chain bake-time gate also checks `optionalDependencies` entries.**
  The `scripts/check-dep-ages.mjs` script now validates exact-pinned packages
  in both `dependencies` and `optionalDependencies` fields — npm and bun install
  `optionalDependencies` by default, so they represent the same supply-chain risk.
  `peerDependencies` remain excluded: the consumer resolves them from a range.
  (Closes #1935)
