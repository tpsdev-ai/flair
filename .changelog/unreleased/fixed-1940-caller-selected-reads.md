- **Non-admin `Memory.get` and `Memory.search` strip inline pointer fields on every read shape, and render a pointer only through the gated join (slice 1 of #1940).**
  A caller-supplied `select` narrows the shape a read returns, so the gated pointer join — which needs
  the row's `id` and `instanceToken` to render a pointer — cannot render one from a selection that
  omitted them. Such a result, in every shape (a full row, a selected row with or without
  `id`/`agentId`, and a single-property result), carries no inline pointer field
  (`hostSource`, `hostSourceScope`, `hostSourceVisibility`) from the Memory row: the inline fields are
  stripped from every returned object, and a single-property read of one of those fields returns
  nothing — the same no-value shape an absent field gives, not a 404 that would confirm the row.
  `SemanticSearch` results follow the same rule.

  (Refs #1940)
