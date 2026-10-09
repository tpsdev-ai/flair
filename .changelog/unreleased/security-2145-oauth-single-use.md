- **A claim to redeem an authorization code or rotate a refresh token is recorded once per instance before any token is issued.** (flair#2145)
  Authorization codes and refresh tokens are refused after a successful claim
  on the same instance. If the claim store is unavailable, token issuance is
  refused with `503 temporarily_unavailable`.
