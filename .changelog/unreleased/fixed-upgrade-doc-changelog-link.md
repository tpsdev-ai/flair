- **`docs/upgrade.md` no longer links to a CHANGELOG that isn't there.** The guide ships in the npm
  package and pointed at `../CHANGELOG.md`, which the `files` allowlist excludes — so the first
  instruction in the upgrade guide was a dead link for every reader who installed from the registry.
  The three links now resolve to the published copy on GitHub, rather than adding a 1400-line file
  to an install that is already too heavy.
