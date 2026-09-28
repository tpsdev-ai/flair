- **Non-admin `Memory.get` and `Memory.search` decide pointer rendering on the stored row, then apply the caller's selection to the output (slice 1 of #1940).**
  A `select` or `property` shapes only the OUTPUT. The read itself runs without it — the same id, or
  the same conditions, operator, limit, offset and sort, under the same read scope — so each full
  stored row goes through the gated pointer join, which sees the stored `id`, `agentId`,
  `instanceToken`, `archived` and `visibility`. The caller's selection is applied afterwards. So an
  archived row renders no pointer even when the selection omits `archived`, and a caller cannot move
  the pointer decision by choosing which fields it asks for. Two selection shapes are supported: a
  single field name — a string `select`, or `property` on a by-id read — returns that field's value,
  and an array of field names returns an object with those keys (a values array when flagged
  `asArray`). Any other shape is refused with 400 before any read, and the message names the two
  supported shapes. Inline pointer fields (`hostSource`,
  `hostSourceScope`, `hostSourceVisibility`) are stripped from the projected row, so a single-field
  read of one of them returns no value rather than the inline string. `SemanticSearch` results are
  projected through the same gated join. Admin and internal reads are unchanged.

  (Refs #1940)
