- **Agent-auth and federation nonces are recorded once per instance, in a table every Harper worker thread shares.** (flair#2061)
  A TPS-Ed25519 request's nonce, and a federation body's nonce, is written to
  the new local `ReplayNonce` table after the signature verifies and before the
  request takes effect, under a per-key lock, so each nonce is accepted once
  across all worker threads of the instance. A request whose nonce cannot be
  recorded is refused with `503 replay_store_unavailable`, and the server log
  names the cause. Rows expire after 120 s through Harper's own expiration
  scan, which runs once per instance. The federation `Nonce` table declaration
  and its five-minute sweep are retired; no rows are migrated.

  > **Heads-up:** `FLAIR_AGENT_AUTH_WINDOW_MS`, if you set it, must stay below
  > 60000. A larger window refuses every TPS-Ed25519 request with
  > `replay_store_unavailable`, and the log names the variable.
