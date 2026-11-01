- **Docs in the published package link only to files the package contains.** References
  to repository files that do not ship — `DESIGN.md`, `CHANGELOG.md`, `CONTRIBUTING.md`
  and the per-package READMEs — use their GitHub URLs, and the docs-freshness gate
  fails when a doc under `docs/` or `README.md` names a `.md` file that is not in the
  `npm pack` file list.
