- **The supply-chain bake-time gate now also checks exact-pinned external `optionalDependencies`, not only `dependencies`.**
  npm and bun install `optionalDependencies` by default ("optional" means a
  failed install is non-fatal, not skipped), so they carry the same risk as any
  other production dependency. At the time of this change the gate checks 16
  pinned dependencies here instead of 9: the seven `@node-llama-cpp/*` platform
  binaries that `packages/flair-bench` declares as optional. `peerDependencies`
  and `devDependencies` are still not checked.

  The collection rule moved from `scripts/check-dep-ages.mjs` into
  `scripts/lib/check-dep-ages-collect.mjs` (`collectDeps`), which the script
  imports relative to itself. An unexpected error, such as a missing
  `packages/` directory, now exits `2` (the registry-failure code); in the
  last release it was an uncaught exception that exited `1`, the too-fresh
  code. Outside `--ci` runs, `FLAIR_CHECK_DEP_AGES_ROOT` overrides the scanned
  repository root; CI refuses the variable. Unit tests now run the gate against a fixture repository and a local
  registry, and assert both fail-closed exits: `1` with the too-fresh
  diagnostic under a 7-day policy, and `2` when the registry is unreachable.

  > **Heads-up:** a project that copies the gate, as described in
  > `docs/supply-chain-policy.md`, needs both files now: copy
  > `scripts/lib/check-dep-ages-collect.mjs` into a `lib/` directory beside
  > the script, keeping the relative layout, or the script fails at import.

  (Closes #1935)
