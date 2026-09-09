- **Dependency security bumps.** `js-yaml` is bumped to 4.3.2, closing a HIGH
  advisory (GHSA-2883-xcg3-v3hh — `maxTotalMergeKeys` did not count empty merge
  sources, so a crafted YAML document could burn CPU past the configured limit).
  `hono` is bumped to 4.13.5+ (resolving 4.13.7), closing three MODERATE
  advisories: an incomplete `toSSG()` path-traversal fix, unbounded dot-notation
  nesting in `parseBody()`, and query-parameter parsing after the URL fragment.
  Both are forced via package.json overrides so bun and npm installs resolve the
  patched versions.
