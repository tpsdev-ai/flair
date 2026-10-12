- **A jwt-bearer grant is refused when the IdP credential it matches is not active.**

  The XAA jwt-bearer grant now refuses a matched IdP credential whose status is
  not `active` — `revoked`, the status the revoke path writes — with
  `invalid_grant`: no token is issued and the credential's `lastUsedAt` is left
  untouched.

  The touch commits only after the committed credential row is re-read and
  confirmed to still be that active credential, so a revoke or a delete that
  commits before that read refuses the grant rather than being undone by the
  touch. A change committed after that read is not seen by it: Harper has no
  compare-and-set on a table write.
