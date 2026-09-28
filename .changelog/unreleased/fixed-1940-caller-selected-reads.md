- **Non-admin `Memory.get` and `Memory.search` accept a selection only as an array of Memory schema attribute names (slice 1 of #1940).**
  A `select` shapes only the OUTPUT; the read itself runs without it — the same id, or the same
  conditions, operator, limit, offset and sort, under the same read scope — so each full stored row goes
  through the gated pointer join, which sees the stored `id`, `agentId`, `instanceToken`, `archived` and
  `visibility`. An accepted array reduces each row to exactly the named keys, a missing or undefined
  value becoming null, in the requested order. Every other shape — a scalar `select`, a `property`, an
  empty selection, the wildcard `*`, a virtual or nested name, a name not in the Memory schema, a
  trailing or doubled comma, a `select` object, or options attached to the selection array — is refused
  with 400 before any read, including the auth middleware's pre-read. Admin and internal reads are
  unchanged.

  (Refs #1940)
