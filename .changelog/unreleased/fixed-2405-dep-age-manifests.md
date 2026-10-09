- **The bake-time gate fails on an unreadable workspace manifest, classifies
  dependency ranges, and names applied exemptions (flair#2405).**

  A `packages/*/package.json` the gate cannot read or parse now fails it with an
  error naming the file, instead of being skipped. A `dependencies` or
  `optionalDependencies` entry is classified by the same version classifier the
  override grammar uses, so a range such as `1.x` is reported as a range rather
  than fetched as an exact version. A passing run that relied on a dated
  exemption names it, with its count, on the exit-0 success line.
