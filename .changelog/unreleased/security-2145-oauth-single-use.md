- **A redeemed authorization code, and a rotated refresh token, are recorded once per instance before any token is issued.** (flair#2145)
  Both go through the shared lock-then-insert record (`flair.OAuthSingleUse`,
  keyed by the code's or token's SHA-256, so it holds no redeemable secret)
  under a per-key lock, so a code or refresh token presented to this Harper
  instance twice is refused the second time, and simultaneous presentations of
  one yield exactly one token pair. When the store is unavailable or the write
  fails, that grant is refused with `503 temporarily_unavailable`
  (`replay_store_unavailable`), and the server log names the cause. A
  misconfigured `OAuthSingleUse` or `IdJagReplay` table is named in the boot
  report before the first request. New rows expire after 8 days.
