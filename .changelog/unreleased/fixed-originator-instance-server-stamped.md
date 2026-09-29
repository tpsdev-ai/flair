- **`originatorInstanceId` is server-stamped on every application write: a create stamps the local id, an update keeps the stored value.**

  `originatorInstanceId` names the federation instance that authored a record and
  the schema has always documented it as server-stamped and never
  client-writable, but each synced resource only stamped it when the request
  body's value was null (`== null`). A caller could therefore supply or change
  the field on both create and update — and the raw writers that bypass the
  resource classes (the feed ingest and the agent-seed / principal-provisioning
  paths) did not stamp it at all.

  Now a **create** (`post()`, or a `put()`/`patch()` onto a row with no stored
  counterpart) stamps this instance's own id and ignores any request-body value;
  an **update** keeps the stored value — a body value neither replaces nor clears
  it, and an update that omits the field leaves it. A row written before this
  release that carries no value stays without one on a later update (the field is
  additive, never invented on update). `PATCH` bodies can no longer set it, and a
  `PATCH` that creates a row is stamped too. The pre-existing row is resolved by
  the URL-bound target id, never by a request-body `id`; a body id that disagrees
  with the address, or a stored-row read that fails, refuses the write rather than
  being read as a create. The paths covered: `Memory`, `Soul`, `Agent` and
  `Relationship` (`post()`/`put()`/`patch()`, and Memory's `_reindex` re-PUT), the
  `POST /FeedMemories` ingest, `POST /AgentSeed`, and the MCP / IdP principal
  provisioning paths (one shared delegate, `resources/originator-instance.ts`).

  The federation merge path keeps the value carried in the pushed row: it applies
  rows through the raw table handle, never through a resource's write method, and
  takes the originator from the record's own already-authenticated data. That
  body is not body-less — `POST /FederationSync` IS reachable over REST — but it
  is trusted only after the handler verifies a batch signature against the
  sending paired peer's pinned key (and each record's signature against its
  claimed originator's key) and the peer is a known, non-revoked pair.

  > **Scope:** the stamp is enforced at the resource layer for every REST /
  > application write. Two trusted raw-table paths sit outside it by design — the
  > signed federation merge above, and Harper's administrator ops API (`:9925`),
  > which can set any column under admin auth. Neither is a client request body.
  >
  > **Heads-up:** if a client or script relied on setting `originatorInstanceId`
  > through `POST`/`PUT`/`PATCH`, that value is now ignored — the server stamps
  > it. Nothing else about the field changed.
