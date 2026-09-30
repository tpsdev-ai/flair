- **Application creates derive `originatorInstanceId` from the local instance identity, or stamp null when unavailable; updates preserve the stored value.**

  Application writes derive originator attribution on creates and preserve
  stored attribution on updates, including feed ingestion and principal
  provisioning.

  Now a **create** (`post()`, or a `put()`/`patch()` onto a row with no stored
  counterpart) stamps this instance's own id, or null when no canonical instance
  identity is available, and ignores any request-body value;
  an **update** keeps the stored value — a body value neither replaces nor clears
  it, and an update that omits the field leaves it. A row written before this
  release that carries no value stays without one on a later update (the field is
  additive, never invented on update). `PATCH` bodies cannot set it, and a
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
  `POST /FederationSync` verifies the batch against the known, non-revoked
  sending peer's pinned key and verifies any record signature against its
  envelope originator's pinned key; an omitted envelope originator defaults to
  the sending peer and need not equal `data.originatorInstanceId`. Record
  signatures are verified when present; an operator can require them.

  > **Scope:** the stamp is enforced at the resource layer for every REST /
  > application write. Federation and the administrator operations API are
  > exceptions to resource-layer stamping: verified federation batches use raw
  > table writes, and authenticated administrators can write columns through the
  > configured operations endpoint.
  > The other raw-table writers (the feed ingest, `POST /AgentSeed` and the MCP /
  > IdP provisioning paths) apply the rule themselves, as the list above says.
  > These exceptions accept authenticated requests outside the application
  > resource stamping rule.
  >
  > **Heads-up:** application `POST`/`PUT`/`PATCH` bodies do not choose
  > `originatorInstanceId`; creates derive local identity and updates retain
  > stored attribution.
