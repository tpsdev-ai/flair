- **The post-publish canary's promote command is bound to one package-set digest, and prereleases are never promoted to `latest`.**

  The canary's `PASS` verdict used to print a separate sha256 check per
  lockstep package. It now re-derives the same package-set digest the release
  run's pack job certified (a single sha256 over the canonical, sorted list of
  `<name>@<version> <sha256>` lines) and requires the paste-time re-derivation
  to equal it before any tag can move; a mismatch — or a package whose published
  tarball cannot be re-hashed — is a refusal, never a match.

  The canary's sha step asserts the dispatched `package-set-digest` against the
  re-derived digest before any verdict, so a digest that does not match the
  certified set is a `FAIL` verdict (with both digests named), never a promote.

  A SemVer prerelease is never promoted: its `PASS` prints a note that the
  version lives on `next` and that `latest` moves only for a version that is
  exactly a `<major>.<minor>.<patch>` (a whole-string match; a prerelease
  label, build metadata, or any other text is not promoted), and prints no
  `dist-tag add` lines at all. The `FAIL`
  verdict (deprecate every lockstep package, the CLI first) is unchanged.

  (Refs #1671)
