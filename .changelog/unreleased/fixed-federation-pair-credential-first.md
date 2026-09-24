- **federation pair checks the spoke admin credential before it contacts the hub, so a missing credential no longer burns the pairing token.**

  `flair federation pair` posts to the hub's `FederationPair`, which consumes the
  one-time pairing token, and the local hub-peer record then needs the SPOKE
  admin credential to write. On a missing or refused credential the token was
  already spent, leaving the caller paired on the hub with no local Peer record
  and only a re-mint available. The credential is now resolved and preflighted
  against the local ops API before the hub request: with no credential it exits
  with "Nothing was sent; the pairing token is still valid", a refused credential
  (401/403) or an unreachable ops API exits the same way, and only a 2xx lets the
  hub request go out. A genuine local Peer write failure after a successful pair
  still errors, now naming that the token has been consumed and how to mint a
  new one.

  (Closes #1875)
