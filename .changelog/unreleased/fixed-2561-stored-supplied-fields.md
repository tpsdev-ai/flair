- **Memory `stored` holds only request-supplied text fields; `POST /FeedMemories` returns non-null request-supplied Memory attributes plus listed server-decided fields; no write response carries embedding fields (#2561).**

  `stored`, which a Memory POST, PUT or PATCH returns next to `redactedValues`
  (#2467), holds the string-valued text fields (`content`, `summary`,
  `trigger`) of that write's own request body, each with its stored (redacted)
  value. A text field the request did not send as a string is absent from
  `stored`. This includes a skill write that versions to a successor row: the
  successor carries over the fields its request omits, and `stored` reports
  only the ones the request sent. `redactedValues` counts the same values as
  before.

  The `POST /FeedMemories` response, built from the row the feed stored or
  matched, holds the non-null Memory attributes the request supplied, each as
  stored, plus the fields the server decides for that row: `id`, `agentId`,
  `durability`, `visibility`, `createdAt`, `updatedAt`, `expiresAt`,
  `archived`, `supersedes`, `skillSubjectId`, `instanceToken`,
  `originatorInstanceId` and `provenance` (plus `written` and `redactedValues`
  when present). Any other field the row holds, such as `metadata`, `subject`,
  `tags` or `contentHash`, is in the response only when the request sent it
  with a non-null value.

  No Memory or feed write response carries `embedding` or `embeddingModel`.
  The re-embed PATCH (body `{"embedding": null, "embeddingModel": null}`)
  answers `{ id, updatedAt }`, and the administrator `_reindex` re-PUT answers
  without either field. A Memory POST, PUT or PATCH and a `_reindex` re-PUT
  report a result only when it has no value or is a row-shaped record (a plain
  object with only Memory attributes and `written`, and no `embedding` or
  `embeddingModel` key nested in a value) or an array of them. Any other
  result, such as a wrapper around a row, a nested embedding key, a scalar or
  a successful `Response`, is answered with a `write_response_withheld`
  refusal (500) that says the write completed. A `Response` from the storage
  layer, whatever its status, gets the same refusal, so the refusals these
  writes return as built are their own named errors, which hold no row
  fields. The feed response is a copy of the row holding only the listed
  server-decided fields and the non-null Memory attributes the request
  supplied, plus `redactedValues` when present; a feed result that is absent,
  is not a record or an array of records, or whose copy holds a nested
  embedding key gets the same refusal. `flair reembed` counts a row as re-embedded
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
