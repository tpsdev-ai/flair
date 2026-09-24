- **federation pair checks the spoke admin credential before it contacts the hub, so a missing credential no longer burns the pairing token.**

  `flair federation pair` posts to the hub's `FederationPair`, which consumes the
  one-time pairing token, and the local hub-peer record then needs the SPOKE
  admin credential to write. On a missing or refused credential the token was
  already spent, leaving the caller paired on the hub with no local Peer record
  and only a re-mint available. The credential is now resolved and preflighted
  before the hub request: with no credential it exits with "Nothing was sent to
  the hub; the pairing token is still valid", and so does a refused credential
  (401/403), an unreachable ops API, or a credential that cannot WRITE the Peer
  table. The preflight uses the ops API's `user_info` and requires a super_user
  or an explicit `flair.Peer` insert+update grant — a read-only credential can
  search but would be refused by the upsert itself, by which time the token is
  gone. A super_user is the supported credential; for any other role the check
  is at TABLE level only (insert+update on `flair.Peer`, plus the operations
  allowlist) — attribute-level grants are not visible to the preflight, so a
  role with table access but restricted attributes still passes here and the
  consumed-token path reports any later refusal. Endpoints printed in these
  errors have any userinfo and query string redacted, and no fetch's own error
  message (which can embed the user-supplied URL) is printed — only its code or
  name. The DB key fallback uses the same credential sources and ops endpoint
  as the preflight, and a genuine local Peer write failure after a successful
  pair still errors, now naming that the token has been consumed and how to
  mint a new one.

  (Closes #1875)
