- **`flair upgrade` keeps the new version when `/Health` refused
  the connection.** A failed post-upgrade restart rolls back only when
  `@tpsdev-ai/flair` itself was swapped, the previous version is known,
  and `/Health` was up or indeterminate. `--no-verify` is included.
  A refused connection keeps the new version even when the previous
  version cannot be read.
  `no-target` is either of two cases: Flair was not swapped, or it was
  swapped and the previous version is unknown after a running or
  indeterminate probe. When the registry reports a deprecation, that
  version is not the rollback target; a failed lookup still rolls back.
  A present null `deprecated` field is not treated as active. A failed
  rollback restart exits nonzero. It names that version known-broken
  for this attempt only when this rollback put a previous version in
  place. When no previous tree was restored, the headline stays
  neutral. The message reports whether the previous tree was restored
  and whether a live tree was set aside.

  > **Heads-up:** When `/Health` refused the connection, including with
  > `--no-verify`, a failed post-upgrade restart keeps the new version
  > if `@tpsdev-ai/flair` itself was swapped. An unresponsive `/Health`
  > is not treated as a refused connection.
