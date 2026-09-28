- **`flair upgrade` keeps a stopped install's new version.** A failed
  post-upgrade start rolls back only when `/Health` showed the instance up,
  or when that probe was indeterminate. `--no-verify` is included. Connection
  refused still keeps the new version when the previous version cannot be
  read. When the registry reports a deprecation, that version is not
  reinstalled; a failed lookup still rolls back. A failed rollback restart exits nonzero, names that version
  known-broken, and gives lane-specific recovery, including whether a
  snapshot was restored.

  > **Heads-up:** A stopped or never-started install, including with
  > `--no-verify`, keeps the new version when the post-upgrade start fails.
  > An unresponsive `/Health` is not treated as stopped.
