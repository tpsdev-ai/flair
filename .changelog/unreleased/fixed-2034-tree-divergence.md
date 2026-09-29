- **A CLI and an instance in different install trees are now named; `flair init` re-points only a service unit it proves is its own.**

  `flair status`, `flair upgrade`, `flair doctor` and `flair restart` report
  which install tree serves the instance only when the service manager is
  shown to own the process that answered. That process is the one process
  listening on the instance's port, and when the instance reported its own PID
  (`status`, when it can read it) it must be that same process. More than one
  listener, or none, is unknown. Only when the port's listeners cannot be read
  at all (`lsof` missing or failing) does the reported PID stand on its own.
  Harper's PID file is only a cross-check: a live one that names another
  process makes the tree unknown. On macOS the launchd job for
  this data directory must be running as that process; on Linux a systemd user
  unit that names the tree must have it as its MainPID, and systemd must report
  that very file as the unit's FragmentPath. The tree is read from the process.
  Without that proof (a remote `--target`, a directly started server, a
  system-level or other supervisor, a server under a different HOME, a host
  where the port's listeners cannot be read and no PID was reported) the
  serving tree is unknown and no remedy is derived from it.

  When a different npm-global tree (`…/lib/node_modules/@tpsdev-ai/flair`) is
  proven to serve, the commands print both trees and both versions ("unknown"
  where a version cannot be read) and the remedy `flair init && flair restart`,
  with `npm i -g @tpsdev-ai/flair` first when this CLI's tree has the older
  flair, or a hand edit when systemd applies drop-ins to the unit. `flair
  status` decides its version hints from that one comparison and prints each
  hint once; `status --json` carries the same comparison. `flair upgrade` prints
  a proven divergence once and does not report "Everything is up to date" while
  one is proven. A plain tree or a checkout serving the instance is reported as
  separately managed and is never re-pointed.

  `flair init` re-points the instance's own service unit at this CLI's tree,
  changing only its launcher, node, Harper entry and working directory, and
  writes nothing unless every check below holds. A refusal names the file, what
  did not match, and the remedy: the paths to set by hand, an update of this
  CLI's tree, or a reinstall.

  - macOS, the adopted pass-file plist, read as XML structure: a plist whose
    XML declaration names an encoding other than UTF-8, or that has an XML
    comment, CDATA, a character reference, a duplicate key or an unsupported
    XML element, is refused. It must declare exactly one Label (this
    data directory's) in the top-level dict, ROOTPATH (this data directory) and
    HOME (this user's) in its EnvironmentVariables dict, no `Program` key, and
    ProgramArguments of exactly the launcher in its WorkingDirectory tree, this
    instance's admin-pass file, a `node` binary and a Harper entry inside that
    tree.
  - Linux, the systemd user unit proven above: exactly one `WorkingDirectory=`
    (the served tree) and one `ExecStart=` in [Service], in one of two shapes,
    `<node> <harper.js> run .` or `<launcher> <admin-pass file> <node>
    <harper.js>`, with no prefix but `-`, no quoting, specifier, variable or
    line continuation. Operator arguments are never rewritten (the admin-pass
    argument is kept as it is), a unit with any other argument is refused, and
    a path of this CLI's that would need quoting in a unit is refused rather
    than written. Drop-ins refuse the re-point, whether systemd reports them
    from any location or a `<unit>.d` directory sits beside the file.
  - Both, when moving the unit to a different installed tree: the old tree's
    flair version and this CLI's must be strict semver, and the CLI's must not
    be older by semver ordering, prereleases included (`0.57.0-beta.1` is older
    than `0.57.0`); otherwise a downgrade cannot be ruled out and nothing is
    written. (A plist already serving this CLI's tree has a missing runtime
    path replaced without that version check.) A unit serving this CLI's tree
    with a different, existing node is a deliberate pin that init leaves as it
    is (init and doctor report it, with the hand edit that moves it).
  - The write is atomic and lands only over the bytes it was planned from: the
    file is read as a regular file (a symlink is refused, never followed) whose
    bytes are valid UTF-8 (anything else is refused before planning), and its
    bytes are re-checked, with its identity, immediately before the rename, so
    an edit saved in between refuses the write. On Linux init first records
    what systemd holds for the unit (nothing is written if it cannot), then
    runs `systemctl --user daemon-reload` (which also loads any other pending
    edits to that user's units) and asks systemd whether it loaded the same
    file, with no drop-ins and the new working directory. If the reload fails or
    systemd does not hold that, init restores the previous bytes, reloads again
    and asks again. That check covers three fields: when systemd's
    FragmentPath, drop-ins and WorkingDirectory are back at the values
    recorded before the write, the message says exactly that and still calls
    full agreement between the restored file and systemd unverified; when they
    are not, or when the restore or the second reload fails, the message
    states what the file holds and that systemd's state is unverified.

  `flair init` is still the full setup command and also re-runs its other
  idempotent setup for the data directory, which creates or saves instance
  state. `flair restart` restarts through the proven systemd user unit on
  Linux, and afterwards reports which tree serves the instance.

  `flair init` and `flair doctor --fix` also re-point the federation-sync shim
  when it runs another npm-global tree. Only the shim's exec line changes; the
  launchd/systemd scheduler unit is only read and stays byte-identical. The
  shim is refused when its commands differ from what `flair federation sync
  enable` writes in anything but the two paths on the exec line (comment lines
  are not compared), when it is a symlink or not valid UTF-8, when it changes
  between the read and the rename, or, when moving it to a different
  installed tree, when that tree's version (or this CLI's) is not strict
  semver or is newer (a shim already running this CLI's tree has a missing
  node replaced without that check); an unreadable unit or shim
  is refused, and a leftover shim without an enabled scheduler is left alone.

  `flair doctor` runs an install-tree check on every run. A different node
  binary serving this CLI's own tree is reported as a deliberate runtime pin
  that `flair init` does not change; a unit serving another tree is one issue,
  and `--fix` counts it fixed only after the unit was re-pointed, the instance
  restarted and the serving tree re-proven to be this CLI's.

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
