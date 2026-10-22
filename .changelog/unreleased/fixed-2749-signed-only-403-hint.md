- **A credential-less signed-only request refused with 403 gets a hint naming the agent key, not `FLAIR_ADMIN_PASS`, if no agent key succeeds on retry.**

  A signed-only request (for example `flair rem restore --apply --dry-run` to
  a non-loopback target given neither `--admin-pass` nor `--admin-pass-file`)
  does not send the admin password. When it goes out with no Authorization
  header, the instance answers 403, and no key in the keys directory gets a
  successful answer on the retry, the error now says the admin password is not
  sent on this path and names where the agent key goes: the named agent's key
  path, or the keys directory when no agent is named. The wording of the other
  credential-less 403 hints is unchanged.

  A credential-less 403 with an empty body (`Content-Length: 0`), signed-only
  or not, is now handled like one with a body: the keys in the keys directory
  are tried, and if none succeeds the error carries the same hint. In 0.62.0
  it was reported as a bare `HTTP 403` and no key was tried (#2749).
