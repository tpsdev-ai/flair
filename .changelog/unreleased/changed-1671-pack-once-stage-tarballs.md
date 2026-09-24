- **The release packs every publishable package once and stages the exact tarballs, not the source tree.**

  The release workflow now builds in a single `pack` job, packs one tarball per
  package with `npm pack --ignore-scripts`, and writes a manifest binding each
  tarball's sha256 plus a canonical package-set digest. A separate
  `stage-publish` job downloads that artifact by id, re-derives both digests
  from the bytes it received, and stages those exact tarballs — re-hashing each
  file immediately before its own `npm stage publish`, under a throwaway
  `--userconfig` and never a directory. It also enforces that every
  `@tpsdev-ai/*` dependency is pinned to the exact release version. Stable
  versions stage under `staged`; prereleases under `next`. Nothing is live until
  an operator approves the staged entries on npmjs.com, as before.

  (Refs #1671)
