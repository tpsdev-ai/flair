- **An XAA assertion's `jti` is recorded once per instance, under the same per-key lock as agent-auth and federation nonces.** (flair#2073)
  A `jwt-bearer` grant whose assertion carries a `jti` records it in
  `IdJagReplay` after the assertion validates and before any token is issued,
  so the assertion is accepted once across all worker threads of the instance.
  When the store is unavailable or the write fails, the grant is refused with
  `503 temporarily_unavailable` (`replay_store_unavailable`), and the server log
  names the cause. New rows expire after 25 hours. Rows written by earlier
  releases are kept and still refuse their `jti`.

  > **Heads-up:** an assertion that carries a `jti` must also carry an `exp` no
  > more than 24 hours (plus 30 seconds of clock skew) ahead. Otherwise the
  > grant is refused with `400 invalid_grant`.

  (Closes #2073)
