- **New admin-only `POST /AgentKeyRegister` registers an agent key.**

  Accepted credentials: Basic admin or an Ed25519 agent with the admin annotation.
  A Harper Bearer token is refused. Under Flair's per-agent registration lock,
  the route reads a fresh local, non-deactivated row with `publicKey: "pending"`
  and confirms it is unchanged and still `pending` before commit in one owned
  transaction. The lock serializes Flair registration writers; raw operations-API
  writes do not take it. A change committed after the confirmation read and before
  commit is not seen; a commit-time pending check is a follow-up. A non-`pending`
  row is refused with a pointer to key rotation. The response returns the stored
  key read back after commit. Each
  committed registration appends an `AgentKeyRegistration` audit row and an
  `agent_key_registered` OrgEvent. The audit `keyFingerprint` and the event
  `detail` carry the key's fingerprint, not the key; the audit `agentId` and the
  event `refId` carry the target agent's id, which the event `summary` also names
  in text.
