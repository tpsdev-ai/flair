- **The pairing-cleanup sweep follows the identity row's role on every tick, and drops orphan bootstrap users too.**

  Two defects, one fact about the instance. The sweep read the instance role ONCE, when the module
  loaded — before a hub's identity row is seeded, since the seed runs after the
  server has started — so a fresh hub saw "not a hub", disabled cleanup for the
  life of the process, and never re-read. It re-reads on every tick now, so a
  hub whose row appears after startup starts sweeping with no restart.

  Second, the sweep walks the `pair-bootstrap-*` users themselves
  (`list_users`), so a user whose token record is gone — invisible to a
  token-only sweep — is dropped as well. A live, unexpired token still keeps its
  user.

  More than one `Instance` row is logged as an error naming its remedy, never
  "first row wins".
