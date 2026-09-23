- **The post-publish canary no longer needs repo dependencies — its tarball
  hasher validates versions with a built-in SemVer 2.0.0 regex.**

  `scripts/ci/registry-tarball-sha256.mjs` imported `semver`, but the canary runs
  on a clean, credential-less runner that installs nothing, so it crashed before
  hashing a single tarball and refused to promote a partial set. The script is
  now dependency-free, and a new unit test guards the class: no script the canary
  runs may import a bare package specifier.

  The canary's sha256 helpers also FAIL CLOSED now (round 2).
  `registry-tarball-sha256.mjs` and `lockstep-packages.mjs` decided "am I the
  entry point?" with `resolve()`, which does NOT follow symlinks, so a checkout
  reached through one made them load, skip `main()`, print nothing and exit 0 — an
  unmeasurable tarball read as a pass. Both compare REAL paths now. The workflow
  additionally requires each sha to be 64 hex chars before it may enter
  `LOCKSTEP_SHAS` (a count of lines is not a count of values), the verdict refuses
  any binding that is not a 64-hex sha256, and the emitted promote preflight
  refuses an empty re-hash rather than matching it.

  (Closes #1856)
