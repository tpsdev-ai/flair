- **A claim to redeem an authorization code or rotate a refresh token is recorded once per instance before any token is issued.** (flair#2145)
  Both go through the shared lock-then-insert record (`flair.OAuthSingleUse`,
  keyed by the code's or token's SHA-256, so it holds no redeemable secret)
  under a per-key lock, so a previously claimed code or refresh token
  is refused on reuse. A single-use row records that a redemption was claimed.
  The handler attempts the later `used` or revocation write before issuing
  tokens. If that write fails, no token
  pair is issued; the claim remains, so the code or token cannot be redeemed
  again. Concurrent valid redemptions of one value issue at most
  one token pair. A failure during the store claim refuses that grant with
  `503 temporarily_unavailable`
  (`replay_store_unavailable`), and the server log names the cause. A
  misconfigured `OAuthSingleUse` or `IdJagReplay` table is named in the boot
  report before the first request. The table has an eight-day expiration
  setting; Harper's scan may remove rows later, but no earlier than that age.
