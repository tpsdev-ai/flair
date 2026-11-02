- **Docs-freshness can waive a fragment when the PR event login matches `renovate[bot]` and every changed Git basename is `package.json`, `bun.lock`, `bun.lockb`, `package-lock.json`, or `npm-shrinkwrap.json`.**

  During release PR preparation, `feat` and `fix` commits since the tag selected by
  `git describe` enter Dependencies when their recorded author name matches
  `renovate[bot]` and every changed Git basename matches that list (#2872).
