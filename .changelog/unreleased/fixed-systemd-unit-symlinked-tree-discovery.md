- **`flair upgrade` now finds a systemd unit that names the tree through a symlinked path.**

  Discovery canonicalizes the tree (`readFlairPackageAt` → `canonicalPath`)
  before matching, but the unit on disk holds whatever path the operator wrote,
  so any symlink in that path meant no unit was found and the upgrade restarted
  the instance **outside** systemd — silently losing systemd supervision
  (`systemctl status` no longer describing the running process). Discovery now
  extracts the ACTIVE `[Service]` `WorkingDirectory` and `ExecStart` path
  operands and compares canonical-to-canonical, resolving a symlinked operand
  via its deepest existing ancestor (a `WorkingDirectory` must equal the tree;
  an `ExecStart` operand must be inside it, on path-component boundaries).

  The same rewrite removes the matching side's **false positives**: a canonical
  path inside a comment, or an unrelated pathname that merely *contains* the
  tree path, no longer selects a unit. Comments and inactive directives are
  ignored; quoted/escaped operands are tokenized with systemd's rules rather
  than split on whitespace; operands carrying a `%`-specifier or `$` variable
  are not treated as host paths. `RootDirectory`/`RootImage`/bind mounts mean
  host realpath is not universal proof of service identity, so automatic
  matching stays scoped to host-path semantics and `FLAIR_SYSTEMD_UNIT` remains
  the escape hatch. (Refs #1758)
