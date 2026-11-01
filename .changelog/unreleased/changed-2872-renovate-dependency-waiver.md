- **The docs-freshness gate can waive a changelog fragment for a Renovate PR changing only `package.json`, `bun.lock`, `package-lock.json`, or `npm-shrinkwrap.json`.**

  The gate reads the PR author login from the workflow event. At release, `feat` and
  `fix` commits since the tag selected by `git describe` enter Dependencies when
  their recorded author name matches `renovate[bot]` and their changed paths use
  those four basenames (#2872).
