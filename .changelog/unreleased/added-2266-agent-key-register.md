- **New admin-only `POST /AgentKeyRegister` registers a caller-held Ed25519 key on an agent row whose stored key is exactly `pending`.**

  The caller must be a verified Flair admin. The key is written only while the
  stored value is exactly `pending`, on a local, non-deactivated row; a
  non-`pending` row is refused with a pointer to key rotation. The operation runs
  under a per-agent lock in one owned transaction, confirms the committed row
  before the commit, and returns the stored key read back after the commit. Each
  committed registration appends an `AgentKeyRegistration` audit row and an
  `agent_key_registered` OrgEvent. The audit `keyFingerprint` and the event
  `detail` carry the key's fingerprint, not the key; the audit `agentId` and the
  event `refId` carry the target agent's id, which the event `summary` also names
  in text.
