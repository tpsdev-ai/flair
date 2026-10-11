- **Once a revoke of an OAuth refresh token has committed, a later rotation of that token is refused and issues no token pair (flair#2333).**

  The revocation endpoint records the same single-use claim the refresh grant
  takes, and the refresh grant re-reads the stored token after taking its own
  claim. A refresh presented after the token's revoke has committed is refused
  with `invalid_grant` (`token revoked`).
