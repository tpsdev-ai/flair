- **The post-publish canary no longer needs repo dependencies — its tarball
  hasher validates versions with a built-in SemVer 2.0.0 regex.**

  `scripts/ci/registry-tarball-sha256.mjs` imported `semver`, but the canary runs
  on a clean, credential-less runner that installs nothing, so it crashed before
  hashing a single tarball and refused to promote a partial set. The script is
  now dependency-free, and a new unit test guards the class: no script the canary
  runs may import a bare package specifier.

  (Closes #1856)
