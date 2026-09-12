- **Federation pair now requires the hub's public key.** `/FederationPair` returns `instance {id, publicKey}` or errors; the spoke refuses to store an empty hub key (flair#822).

  Pairing used to succeed while writing `publicKey: ""` on the spoke's hub-Peer row when the hub omitted its Instance identity. Outbound sync still worked (the hub verifies the spoke); hub-origin verification had nothing to check.

  > **Heads-up:** `flair federation pair` exits non-zero if the hub does not return a public key and `GET /FederationInstance` cannot fill it. Provision the hub identity (`GET /FederationInstance` or `flair init --remote`) before pairing.
