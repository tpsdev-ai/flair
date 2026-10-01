- **An XAA assertion's `jti` is recorded once per instance, under the same per-key lock as agent-auth and federation nonces.** (flair#2073)
  When a `jwt-bearer` grant's assertion carries a `jti` and validates, the
  `jti` is recorded in `IdJagReplay` before any token is issued, so the
  assertion is accepted once across all worker threads of the instance. When
  the store is unavailable or the write fails, that grant is refused with
  `503 temporarily_unavailable` (`replay_store_unavailable`), and the server log
  names the cause. New rows expire after 25 hours. Rows written by earlier
  releases are kept and still refuse their `jti`.

  > **Heads-up:** a `jti` claim, when present, must be a nonempty string, and
  > the assertion must then carry an `exp` no more than 24 hours (plus 30
  > seconds of clock skew) ahead. Otherwise the grant is refused with
  > `400 invalid_grant`.

  (Closes #2073)
