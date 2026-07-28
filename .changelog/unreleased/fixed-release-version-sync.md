- **Every release went red in CI on a version the release script itself failed to
  bump.** `scripts/release.sh` bumped the eight `package.json` files and nothing
  else, but the version is also declared in `packages/flair-bench/src/version.ts`
  as a plain `TOOL_VERSION` constant — deliberately, since a runtime JSON import
  of `package.json` trips NodeNext import-attribute edges in the published
  `dist/`. A flair-bench test asserts the two are equal, so it failed on every
  release until an operator remembered to hand-edit the constant. It looked like
  a flake. It was not: a documented manual step that a script could perform is a
  gap in the script, and the operator was standing in for a missing line of code.

  The reason it reached CI at all is that `release.sh`'s own test step runs only
  `test/unit/`, `test/integration/` and `test/unit-isolated/`; the flair-bench
  package tests are a separate CI job. The release therefore bumped, built and
  tested green locally and only failed *after* the release branch existed, the
  changelog fragments had been consumed, and the PR was open — which is the
  expensive place to fail.

  `release.sh` now bumps that constant and stages it in the version-bump commit
  (its `git add` list is deliberately explicit rather than `-A`, so a new path
  that is not named there is silently left out of the release). A new
  `scripts/check-version-sync.mjs` backs it from both ends: `release.sh`
  **preflights** it before creating the branch or touching the changelog, so an
  out-of-sync tree costs nothing to recover from, and re-runs it after the bump
  so a missed site cannot be committed. It also runs in CI, where it does the
  part that stops this recurring — a scan that fails when *any* file outside the
  known set declares the release version, so the next version-bearing file
  someone adds is caught on the PR that adds it rather than at a release weeks
  later. The check refuses to pass when it cannot actually run: a scan that finds
  no declaration of the current version anywhere, not even in `package.json`, is
  a broken scan, and it reports that instead of a green tick.
