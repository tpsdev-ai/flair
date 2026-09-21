- **The canary now emits a sha256-bound `npm dist-tag add` line for every lockstep package, so `latest` no longer skews on release.**

  The promote step moved `latest` for one of the nine lockstep packages, so a
  release left `flair` at the new version while `flair-client` / `flair-mcp` /
  the plugins stayed behind — the mismatch `flair#1383` detects at runtime,
  manufactured by the release chain on every release. The canary's PASS block now
  prints one `npm dist-tag add` line per lockstep package (`@tpsdev-ai/flair`
  last, so a partial paste never leads with the CLI), each guarded by its own
  published-tarball sha256; a missing sha refuses the whole block (all or none).
  The FAIL block prints one `npm deprecate` line per package. A new registry-skew
  check names any `latest` that disagrees, the canary runs it before the verdict,
  and the release docs show the block, the `--otp` form under 2FA, and the skew
  check as the last step. The package list is derived once from the manifests —
  never copied into the verdict script.

  (Refs #1781, #1686, #1383)
