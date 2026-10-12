- **On one Harper node, a federation pairing token is consumed by at most one pairing, and a re-pair of an already revoked peer is refused.**

  `POST /FederationPair` runs a pairing token's check-and-consume under a
  per-token lock, so two pairings on one Harper node that present the same token
  cannot both commit a successful claim. A contender exhausting lock attempts
  while the lock is held receives 409 pairing_in_progress; one acquiring it after
  a successful claim commits sees the consumed token and receives 401.
  The consume — a re-read of the token from committed state — and
  the peer write it guards run in a transaction the pairing OWNS and that commits
  before the lock releases, so a pairing that takes the just-released lock reads
  the token consumed, not the request's uncommitted write. An otherwise valid,
  non-revoked re-pair that supplies a token consumes it the same way, so a token
  spent on a re-pair cannot pair a later new peer. With a valid supplied token
  and a matching pinned key, a revoke committed before the
  owned transaction's first read (its token read) is seen by the Peer re-read and
  refused with 403 peer_revoked; a revoke committed after that read is not covered
  by this re-read.
  The lock is one Flair node's PairingToken store lock: it excludes concurrent
  pairings within one Harper node, not across the several nodes a Fabric instance
  can run. A re-pair of a peer whose row is revoked when read is refused and
  changes neither the Peer row nor a pairing token (the anti-replay nonce a signed
  request records is still written). An otherwise valid, non-revoked re-pair that
  supplies NO token still proceeds; it re-reads the peer row inside a fresh owned
  transaction before writing, so a row revoked or deleted before that read is
  refused (403 peer_revoked, or 401 when the row is gone) rather than overwritten.
  Before writing, both re-pair paths compare the re-read row's pinned key with the
  signed request's key: a key that differs is refused (409) and the re-pair writes
  no peer row and consumes no token. A supplied token must pass validation before
  that Peer re-read. A re-pair that supplies a valid token and
  whose peer row was deleted before the re-read is paired as a first-time pair:
  the row is built from the request as a first pair builds it, keeping no field
  of the deleted row.
