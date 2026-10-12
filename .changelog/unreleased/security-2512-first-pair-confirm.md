- **A first-time federation pair confirms its Peer row inside the token transaction and answers `paired` only for a row it stored (flair#2512).**

  The first-pair write re-reads the Peer row inside its owned transaction, after
  the pairing-token consume is staged. A row committed in between is refused 409
  `peer_row_appeared`, leaving that row and its key unchanged and the pairing
  token unconsumed.
