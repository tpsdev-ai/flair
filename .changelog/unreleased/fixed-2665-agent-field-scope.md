- **Federation takes an existing Agent's key and home only from its home instance, and does not set admin roles or create configured admin agents.**

  A record from another peer that would change an existing row's `publicKey`
  or home (`originatorInstanceId`) is skipped whole as `agent_identity_not_from_home`
  (non-retryable). A new Agent row from a peer is stored without
  `role: "admin"` or `admin: true`, and an existing row keeps its stored admin
  state. A record that would create a row whose id the receiver's
  `FLAIR_ADMIN_AGENTS` names is skipped as `agent_admin_id_not_federated`
  (non-retryable). A record an earlier check refuses keeps that check's reason
  (#2665).

  > **Heads-up:** an Agent row with no stored home (a missing, null or empty
  > `originatorInstanceId`) takes no key change from a peer, and a sync does not create an agent whose id `FLAIR_ADMIN_AGENTS`
  > names. The receiving instance's administrator can write the key, or create
  > the agent, through its operations API.
