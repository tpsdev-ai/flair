- **An XAA assertion's `jti` is recorded once per instance, under the same per-key lock as agent-auth and federation nonces.** (flair#2073)
  When a `jwt-bearer` grant's assertion carries a `jti` and validates, the
  `jti` is recorded in `IdJagReplay` before any token is issued,
  so a serving instance accepts the assertion at most once; with `FLAIR_MULTI_WORKER_UNSAFE=1`, that replay refusal spans its workers. When
  the store is unavailable or the write fails, that grant is refused with
  `503 temporarily_unavailable` (`replay_store_unavailable`), and the server log
  names the cause. New rows expire after 25 hours. An existing `IdJagReplay` row is treated as a replay while that row remains in the store.

  > **Heads-up:** a `jti` claim, when present, must be a nonempty string, and
  > the assertion must then carry an `exp` no more than 24 hours (plus 30
  > seconds of clock skew) ahead. Otherwise the grant is refused with
  > `400 invalid_grant`.

  (Closes #2073)
