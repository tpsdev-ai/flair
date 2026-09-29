- **A CLI and a running instance in different install trees are now named, and the remedy re-points the service.**

  `flair status`, `flair upgrade`, `flair doctor` and `flair restart` report
  which install tree serves the instance only when the service manager is
  shown to own the process that answers: on macOS the launchd job for this
  data directory is running as that process, on Linux a systemd user unit that
  names the tree has it as its MainPID. The tree is read from that process.
  Without that proof (a remote `--target`, a directly started server, a
  system-level or other supervisor, a server started under a different HOME)
  the serving tree is reported as unknown and no remedy is derived from it.

  When a different npm-global tree (`…/lib/node_modules/@tpsdev-ai/flair`) is
  proven to serve, the commands print both trees and both versions ("unknown"
  where a version cannot be read) and the remedy `flair init && flair restart`,
  with `npm i -g @tpsdev-ai/flair` first when this CLI's tree has the older
  flair. `flair status` decides its version hints from that one comparison and
  prints each hint once: the divergence replaces the CLI's "is behind" hint,
  the server's version is reported separately from the CLI's, and the
  per-command "server is running" nudge is no longer printed on top of
  `status`; `status --json` carries the same comparison. `flair upgrade`
  prints a proven divergence once, before it lists or installs anything, and
  does not report "Everything is up to date" while one is proven. A plain tree
  or a checkout serving the instance is reported as separately managed and is
  never re-pointed.

  `flair init` now re-points the instance's own service at this CLI's tree:
  the adopted launchd plist (including the pass-file plist it previously left
  untouched) and, on Linux, the systemd user unit proven to own the instance.
  Only the runtime paths change (node, the Harper entry, the launcher, the
  working directory); every other setting in the unit is kept, and the write
  is atomic. It refuses rather than guesses: a unit not in the shape flair
  writes, a systemd unit with drop-in overrides, or a tree with a newer flair
  than this CLI's (which would downgrade the instance). `flair init` is still
  the full setup command and also re-runs its other idempotent setup for the
  data directory. `flair restart` restarts through the proven systemd user unit
  on Linux, and afterwards reports which tree serves the instance.

  `flair init` and `flair doctor --fix` also re-point the federation-sync shim
  when it runs another npm-global tree. Only the shim's exec line changes: the
  launchd/systemd scheduler unit holds no runtime path and is never rewritten,
  so its interval, target, pass-file and any other setting stay as they are.
  An unreadable or hand-changed unit or shim is refused, and a leftover shim
  without an enabled scheduler is left alone.

  `flair doctor` runs an install-tree check on every run. A different node
  binary serving this CLI's own tree is reported as a deliberate runtime pin
  and left alone; a unit serving another tree is one issue, and `--fix` counts
  it fixed only after the unit was re-pointed, the instance restarted and the
  serving tree re-proven to be this CLI's.

  The node path written by `flair init` (launchd plist), by the service and
  federation-sync re-points, and by `flair federation sync enable` (the shim)
  is mise's major-version alias (`…/installs/node/<major>/bin/node`) when it
  resolves to the same binary, and otherwise the exact path. That alias is a
  floating pointer: when mise moves it to a newer runtime of that major, the
  unit runs that runtime from then on. It keeps the node path valid across a
  patch or minor bump; it does not move the install tree, which a Node bump
  still requires re-pointing. Volta's `bin/node` is used only when it resolves
  to the same binary, which a standard Volta shim does not; nvm, fnm and asdf
  expose no such alias, so their exact path is written.

  (Refs #2034)
