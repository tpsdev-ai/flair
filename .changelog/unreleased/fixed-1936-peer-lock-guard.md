- **A workspace package's non-optional peer must now resolve, in `bun.lock`, to a version its declared range allows.**
  `bun install --frozen-lockfile` refuses only a manifest/lockfile mismatch — it
  never checks that a *resolved* peer satisfies the range a package declares. So
  `openclaw-flair` could declare `openclaw >=2026.8.1` while `bun.lock` kept
  installing `openclaw@2026.7.1`, and every CI job that ran the adapter's tests
  used a version the package says it does not support.

  `scripts/check-peer-deps.mjs` now fails when any workspace package's
  non-optional peer, as resolved in `bun.lock`, does not satisfy its declared
  range; optional peers (`peerDependenciesMeta`) are skipped, and a declared
  non-optional peer with no lock resolution fails closed. It runs in the same CI
  job as `check-workspace-deps.mjs`. The lock is refreshed to `openclaw@2026.9.5`
  (the newest release at or above the floor that is past the 7-day bake).

  (Closes #1936)
