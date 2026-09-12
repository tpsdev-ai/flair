- **Spoke pair refuses an empty hub public key.** `flair federation pair` errors (or reads `/FederationInstance`) instead of storing `publicKey: ""` (flair#822).

  Pair already returns `instance.{id,publicKey}` when the hub has a FederationInstance row. An empty spoke hub-Peer key meant that row was missing at pair time (flair#839). This change is fail-closed on the spoke; it does not provision the hub Instance.

  > **Heads-up:** pair now exits non-zero when the hub does not supply a public key. That pair is identity-incomplete. Hub Instance creation remains flair#839.
