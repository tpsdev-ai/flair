- **The post-publish canary binds promotion to a package-set digest and promotes only exact `major.minor.patch` versions to `latest`.**

  The release pack job records a SHA-256 digest of the sorted
  `<name>@<version> <sha256>` lines for the lockstep package set. The canary
  re-derives that digest from published tarballs and compares it with the
  dispatched digest; a mismatch fails the SHA check and produces a `FAIL` verdict.

  For a promotable version, the `PASS` verdict prints a block that re-hashes
  the published tarballs and requires the same package-set digest before moving
  any tag. A failed or malformed hash result, or a digest mismatch, stops that
  block before promotion.

  Build-metadata tags are rejected by release-publish's tag validation before
  staging. Prerelease tags accepted by that validation use the `next` staging
  dist-tag. A canary `PASS` for any version other than an exact
  `major.minor.patch` prints no promotion commands.

  (Refs #1671)
