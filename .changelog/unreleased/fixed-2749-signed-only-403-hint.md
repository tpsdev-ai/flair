- **A credential-less 403 on a signed-only request names the agent key to provide instead of suggesting `FLAIR_ADMIN_PASS`.**

  Such a request (for example `flair rem restore --apply --dry-run` to a
  non-loopback target given neither `--admin-pass` nor `--admin-pass-file`)
  does not send the admin password. Its hint now says so and names where the
  agent key goes: the named agent's key path, or the keys directory when no
  agent is named. The other credential-less 403 hints are unchanged (#2749).
