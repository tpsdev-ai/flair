- **A refresh-token rotation and a revoke of the same token are serialized within one Harper process (#2333).**

  The revocation endpoint takes the same per-token lock a rotation holds across
  its single-use claim, its committed-row re-read, the old row's write and the
  new pair's issuance, and records the same single-use claim
  (`r:<sha256(token)>`) the rotation takes. The rotation's re-read, write and
  issuance run in a fresh, owned transaction that commits BEFORE the lock
  releases, so a request that looks at the token the moment the lock frees sees
  the committed revocation, not a write still sitting in the request's own
  transaction. A rotation that takes the lock after
  a revoke has committed finds the token's claim already recorded and is refused
  and issues no pair; a revoke that cannot take the lock while a rotation holds
  it is refused with `temporarily_unavailable` rather than race it. A claim that
  is already recorded — the token was already rotated, or the revoke repeats —
  is not an error: the revoke still records `revokedAt` on that token alone, and
  does not revoke the pair a rotation already issued.

  A later presentation of a revoked refresh token is refused with
  `invalid_grant` (`token revoked`): the token row's own revocation is checked
  before its expiry and its client, so neither preempts it. Only the token
  endpoint's shared rate limiter (429) can answer first. If the single-use store
  is unavailable, a refresh-token revoke taking the claim answers 503 and records
  nothing. Unknown tokens and access tokens do not take the claim and keep their
  existing responses.
