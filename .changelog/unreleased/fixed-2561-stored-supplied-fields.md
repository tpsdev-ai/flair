- **Memory `stored` holds only request-supplied text fields; `POST /FeedMemories` returns allowlisted primitive fields plus listed response fields; no write response carries embedding fields (#2561).**

  `stored`, which a Memory POST, PUT or PATCH returns next to `redactedValues`
  (#2467), holds the string-valued text fields (`content`, `summary`,
  `trigger`) of that write's own request body, each with its stored (redacted)
  value. A text field the request did not send as a string is absent from
  `stored`. This includes a skill write that versions to a successor row: the
  successor carries over the fields its request omits, and `stored` reports
  only the ones the request sent. `redactedValues` counts the same values as
  before.

  The feed reports allowlisted primitive fields: listed response fields and
  request-supplied fields with non-null request values. Array-valued fields
  are omitted.

  No embedding field whatever storage returns: Memory POST, PUT, PATCH,
  `_reindex` and feed responses are built from named, typed fields in fresh
  plain objects. `stored` is built from its named text fields. A missing or
  wrong-typed required `id` returns `write_response_withheld` (500).
  Storage-layer Responses of any status return the same refusal.
  The re-embed PATCH answers `{ id, updatedAt }`. Any other Memory PATCH
  answers 204 with no body when the server replaced no value, and
  `{ id, written, redactedValues, stored }` when it did; the admin `_reindex`
  re-PUT answers 204 with no body.

  `flair reembed` counts a row as re-embedded
  when the PATCH response names that row and the stored row then carries the
  current model; it reads the model through the operations API when
  administrator credentials are set, and with a signed `GET /Memory/<id>` as
  the agent otherwise, and counts an unsuccessful or mismatched read as an
  error. A `flair reembed` from an earlier release reads the model from
  the PATCH response, so against this server it counts each row it
  re-embedded as an error; use the `flair reembed` of this release.

  The SDK write results and the built-in `/mcp` `memory_store`,
  `memory_update`, `skill_store`, `memory_basement` and `memory_restore`
  echoes treat a `stored` with no string `content` as withheld
  (`contentWithheld: true`) and show no input text in its place.
