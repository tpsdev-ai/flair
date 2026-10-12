- **Refresh-token rotation is refused after a committed revoke within one Harper process (#2333).**

  A refresh-token rotation is refused after a committed revoke within one Harper
  process, without issuing a new pair. A revoked refresh token returns
  `invalid_grant`; an unavailable lifecycle store returns a retryable 503.
