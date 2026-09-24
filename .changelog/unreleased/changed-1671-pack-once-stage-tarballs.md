- **The release packs every publishable package once and stages the exact tarballs, not the source tree.**

  The release workflow now builds in a single `pack` job, packs one tarball per
  package with `npm pack --ignore-scripts`, and writes a manifest binding each
  tarball's sha256, the canonical package-set digest and the run identity
  (repo, tag, commit, run id/attempt, node/npm versions). A separate
  `stage-publish` job downloads that artifact by id, re-derives the manifest and
  package-set digests and requires them to agree with both the manifest and
  pack's outputs, then stages those exact tarballs — re-hashing each file
  immediately before its own `npm stage publish`, under a throwaway
  `--userconfig` and never a directory. A failed or unconfirmed publish is
  reported as INCOMPLETE (APPROVE NOTHING) with the digests and the staged /
  failed / not-attempted sets, never as "nothing staged". It also enforces that
  every dependency on a lockstep member is pinned to the exact release version,
  keeps the tag-commit-on-main ancestry check, and refuses an artifact holding
  anything but the manifest and the tarballs it lists. Stable versions stage
  under `staged`; prereleases under `next`. Nothing is live until an operator
  approves the staged entries on npmjs.com, as before.

  (Refs #1671)
