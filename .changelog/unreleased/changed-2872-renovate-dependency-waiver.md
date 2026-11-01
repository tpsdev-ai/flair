- **The docs-freshness gate waives the changelog fragment for Renovate dependency-only changes.**

  The waiver applies only when the pull request author from the workflow event is the
  Renovate app and every changed path is a dependency manifest or lockfile; release
  notes list the merged dependency commits under Dependencies (#2872).
