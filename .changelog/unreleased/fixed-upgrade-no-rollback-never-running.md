- **Failed post-upgrade restarts keep a swapped Flair package after a refused
  pre-upgrade `/Health` connection.** This includes `--no-verify` and an unreadable previous
  version. With a running or indeterminate probe, a swapped Flair package and
  a nonempty previous version select rollback. No swap, or no previous version
  after a running or indeterminate probe, yields `no-target`.
  A reported deprecation blocks the rollback attempt; failed lookups do not.
  npm-global attempts to reinstall the previous package; plain-tree attempts
  to restore the saved tree when it exists. If a rollback restart throws,
  its diagnostics use the install lane and recorded tree and snapshot
  restoration results.

  > **Heads-up:** After a refused pre-upgrade `/Health` connection, a failed
  > restart keeps the new version only when Flair itself was swapped, exits
  > successfully, and prints `flair start`. Timeouts remain indeterminate.
