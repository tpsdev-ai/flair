- **XAA refuses jwt-bearer grants for matched IdP credentials not marked active.**
  It returns `invalid_grant` without issuing an OAuth token or updating the
  credential's `lastUsedAt`. A detected revoke or deletion during the grant also
  refuses issuance.
