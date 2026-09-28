- **A CLI and a running instance in different install trees are now named, with the fix.**

  `flair status`, `flair upgrade` and `flair doctor` compare the CLI's own
  package dir (realpath) with the tree the running instance is served from — its
  launchd plist on macOS, its systemd unit on Linux. When the two differ they
  print BOTH paths and both versions and the remedy `flair init && flair restart`
  (plus `npm i -g @tpsdev-ai/flair` when the CLI's own tree is the stale one),
  instead of the two hints that used to point at each other. `flair upgrade` no
  longer reports "Everything is up to date" while the trees diverge.

  `flair init` and `flair doctor --fix` now also rewrite the federation-sync
  shim and its launchd/systemd unit against the current Node runtime,
  idempotently, preserving the operator-set interval, target and pass-file. A
  machine that never enabled federation sync is left alone, and instance data is
  never touched. `flair doctor` flags a unit whose node path is not the runtime
  `node` resolves to now EVEN WHEN the old tree still exists.

  Generated node paths prefer a version-manager-stable alias (mise, nvm, fnm,
  volta, asdf) when its realpath is the same runtime, so the next exact-minor
  bump does not move the path again; when no alias resolves to the same runtime,
  the resolved path is written unchanged.

  (Refs #2034)
