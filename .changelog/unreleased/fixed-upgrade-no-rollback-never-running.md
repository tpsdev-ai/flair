- **`flair upgrade` keeps a stopped install's new version.** A failed
  post-upgrade start rolls back only when `/Health` showed the instance
  up, or when that probe was indeterminate, and only when
  `@tpsdev-ai/flair` itself was swapped. `--no-verify` is included.
  Connection refused still keeps the new version when the previous
  version cannot be read. A plugin-only upgrade has nothing to roll
  back. When the registry reports a deprecation, that version is not
  reinstalled; a failed lookup still rolls back. A present null
  `deprecated` field is not treated as active. A failed rollback
  restart exits nonzero. It names that version known-broken for this
  attempt only when a previous version was restored. When no previous
  tree was restored, the headline stays neutral. The message reports
  whether the previous tree was restored and whether a live tree was
  set aside.

  > **Heads-up:** A stopped or never-started install, including with
  > `--no-verify`, keeps the new version when the post-upgrade start
  > fails and `@tpsdev-ai/flair` itself was swapped. An unresponsive
  > `/Health` is not treated as stopped.
