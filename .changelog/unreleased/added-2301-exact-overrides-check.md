- **Root `overrides` that reach a workspace dependency must be exact versions.**
  A CI step and the pre-commit hook enforce it. bun re-checks the registry manifest
  for a ranged dependency of a workspace on a warm install once its cached copy is
  older than its 300 s max-age, so a range costs a manifest request per install.
  A workspace package's own dependency ranges and `peerDependencies` are out of scope,
  and `workspace:` specifiers are exempt (flair#2301).
