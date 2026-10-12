- **On one Harper node, a federation pairing token is consumed by at most one pairing, and a re-pair of an already revoked peer is refused.**

  `POST /FederationPair` runs a pairing token's check-and-consume under a
  per-token lock, so two pairings on one Harper node that present the same token
  cannot both commit a successful claim: the second pairing is refused after the
  first commits. The consume — a re-read of the token from committed state — and
  the peer write it guards run in a transaction the pairing OWNS and that commits
  before the lock releases, so a pairing that takes the just-released lock reads
  the token consumed, not the request's uncommitted write. An otherwise valid,
  non-revoked re-pair that supplies a token consumes it the same way, so a token
  spent on a re-pair cannot pair a later new peer. A revoke committed before the
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
