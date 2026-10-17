- **New admin-only `POST /AgentKeyRegister` registers an agent key.** (#2549)

  Accepted credentials: Basic admin or an Ed25519 agent with the admin annotation.
  A Harper Bearer token is refused. Under Flair's per-agent registration lock,
  the route reads a fresh local, non-deactivated row with `publicKey: "pending"`
  and, at the confirmation read, requires the committed row to equal the
  fresh-read snapshot and still be `pending` before commit in one owned
  transaction. The lock serializes registrations for that agent within one Harper
  process; raw operations-API writes and other processes do not take it. A change
  committed after the confirmation read and before commit is not seen, and a
  change restored before the confirmation read is not observed; a commit-time
  pending check is a follow-up. A non-`pending`
  row is refused with a pointer to key rotation. The response returns the stored
  key read back after commit. Each
  committed registration appends an `AgentKeyRegistration` audit row and an
  `agent_key_registered` OrgEvent. The audit `keyFingerprint` and the event
  `detail` carry the key's fingerprint, not the key; the audit `agentId` and the
  event `refId` carry the target agent's id, which the event `summary` also names
  in text.
