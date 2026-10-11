- **A federation pairing token is consumed by at most one pairing, and a re-pair of a revoked peer is refused.**

  `POST /FederationPair` runs a pairing token's check-and-consume under a
  per-token lock, so two pairings that present the same token cannot both see it
  unconsumed: another pairing that presents a consumed token is refused. A re-pair
  of a peer whose row is revoked is refused and writes nothing.
