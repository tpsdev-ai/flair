- **A refresh-token rotation and a revoke of the same token are serialized, so a commit of one is not outrun by the other (#2333).**

  The revocation endpoint takes the same per-token lock a rotation holds across
  its single-use claim, its committed-row re-read, the old row's write and the
  new pair's issuance, and records the same single-use claim
  (`r:<sha256(token)>`) the rotation takes. A rotation that takes the lock after
  a revoke has committed finds the token's claim already recorded and is refused
  and issues no pair; a revoke that cannot take the lock while a rotation holds
  it is refused with `temporarily_unavailable` rather than race it. A claim that
  is already recorded — the token was already rotated, or the revoke repeats —
  is not an error: the revoke still records `revokedAt` on that token alone, and
  does not revoke the pair a rotation already issued.

  A later presentation of a revoked refresh token is not guaranteed
  `invalid_grant` (`token revoked`) specifically: the refresh-token expiry
  check, the client check and the token endpoint's shared rate limiter (429) are
  decided first. If the single-use store is unavailable, the revoke endpoint
  answers 503 and records nothing.
