- **A redeemed authorization code, and a rotated refresh token, are recorded once per instance before any token is issued.** (flair#2145)
  Both go through the shared lock-then-insert record (`flair.OAuthSingleUse`,
  keyed by the code's or token's SHA-256, so it holds no redeemable secret)
  under a per-key lock, so a previously redeemed code or rotated refresh token
  is refused on reuse. Concurrent valid redemptions of one value issue at most
  one token pair. A failure during the store claim refuses that grant with
  `503 temporarily_unavailable`
  (`replay_store_unavailable`), and the server log names the cause. A
  misconfigured `OAuthSingleUse` or `IdJagReplay` table is named in the boot
  report before the first request. New rows expire after 8 days.
