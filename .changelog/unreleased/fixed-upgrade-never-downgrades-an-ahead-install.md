- **`flair upgrade` no longer proposes or performs a downgrade when the installed version is ahead of registry `latest`.**

  A staged (never-promoted) release — e.g. 0.55.0 while `latest` is still
  0.54.2 — was classified by bare equality, so it read as `outdated`: the
  listing showed `⬆️ 0.55.0 → 0.54.2`, and a plain `flair upgrade` reached
  `npm install -g @tpsdev-ai/flair@0.54.2` and downgraded the install. A new
  `ahead` status (`installed > latest`, compared with a semver library) now
  renders `0.55.0 (ahead of latest 0.54.2)` with no arrow and no remedy, and is
  excluded from every install sink: the npm-global upgrade list, the openclaw
  plugin list, and the plain-tree swap plan (now built only when flair is
  actually outdated). When nothing needs installing, the summary reads
  "No upgrades available" rather than "Everything is up to date".

  The post-install pin refresh also never LOWERS an owned pin: it compares the
  version it would write against the pin present, and holds (with a printed
  line naming both) when the write would be a downgrade — so an unrelated
  package upgrading can no longer drag an ahead `flair-mcp` pin down. After a
  no-op, post-upgrade verification expects the RUNNING version, not registry
  `latest`. An installed version that fails to parse renders as `❔ unknown`
  with the raw string, never as `outdated`, and is never dropped.

  `--flair-version` is unchanged: an explicit pin is still the operator's
  requested target (its downgrade semantics are a later slice), so no
  `--allow-downgrade` flag is added.

  (Refs #1778)
