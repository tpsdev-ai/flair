- **The bake-time gate classifies dependency ranges and names applied exemptions (flair#2405).**

  A `dependencies` or `optionalDependencies` entry is classified by the same
  version classifier the override grammar uses, so a range such as `1.x` is
  reported as a range rather than fetched as an exact version; these ranges
  join the printed override ranges. A passing run that relied on a dated
  exemption names it, with its count, on the exit-0 success line.
