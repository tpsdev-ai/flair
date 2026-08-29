- **The impl-term-leak gate now refuses per source, not only when the whole corpus is empty** (flair#1427).
  A missing `CHANGELOG.md`, an absent `.changelog/`, or an unbuilt
  `packages/*/dist/` used to scan less and still report green because
  `README.md` and `docs/` kept the total non-empty. Each intended source
  must contribute at least one file. Unbuilt `dist/` and built-and-empty
  `dist/` fail with different messages; neither is a passing scan.
