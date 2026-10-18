- **Federation accepts an existing Agent's key and home only from its home instance, and does not take admin authority from a peer.**

  A record from another peer that would change an existing row's `publicKey`
  or `originatorInstanceId` is skipped whole as `agent_identity_not_from_home`
  (non-retryable); a record an earlier check refuses keeps that check's reason.
  A new Agent row from a peer is stored without `role: "admin"`
  or `admin: true`, and an existing row keeps its stored admin state (#2665).

  > **Heads-up:** an Agent row with no stored home takes no key change from a
  > peer. The receiving instance's administrator can write the key through its
  > operations API.
