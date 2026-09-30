- **A workspace package's non-optional peer must now resolve, in `bun.lock`, to a version its declared range allows.**
  `scripts/check-peer-deps.mjs` now fails when any workspace package's
  non-optional peer, as resolved in `bun.lock`, does not satisfy its declared
  range; optional peers (`peerDependenciesMeta`) are skipped, and a declared
  non-optional peer with no lock resolution fails closed. Every workspace listed
  in the lock must have a readable, valid manifest; missing workspace inputs or
  an unreadable `packages/` directory fail with a repair instruction. It runs in
  the same CI job as `check-workspace-deps.mjs`. The lock is refreshed to
  `openclaw@2026.9.5`.

  (Closes #1936)
