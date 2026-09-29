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
  takes the originator from the record's own authenticated data. That path is an
  EXCEPTION to the stamping rule, not a client-writable field.
  `POST /FederationSync` DOES accept a signed HTTP body: a batch is applied only
  after the handler verifies the batch signature against the sending peer's
  pinned key — the peer must be a known, non-revoked peer — and, when a record
  carries one, the record's own signature against the pinned key of the record's
  ENVELOPE originator (`record.originatorInstanceId`, which defaults to the
  receiver and need not equal the stored `data.originatorInstanceId`). Record
  signatures are verified when present; an operator can require them.

  > **Scope:** the stamp is enforced at the resource layer for every REST /
  > application write. Federation and the administrator ops API are EXCEPTIONS to
  > the stamping rule, not the field's only raw writers: the signed federation
  > merge above applies a verified peer's rows through the raw table handle, and
  > Harper's administrator ops API (`:9925`) can set any column under admin auth.
  > The other raw-table writers (the feed ingest, `POST /AgentSeed` and the MCP /
  > IdP provisioning paths) apply the rule themselves, as the list above says.
  > Neither exception is a client request body.
  >
  > **Heads-up:** if a client or script relied on setting `originatorInstanceId`
  > through `POST`/`PUT`/`PATCH`, that value is now ignored — the server stamps
  > it. Nothing else about the field changed.
