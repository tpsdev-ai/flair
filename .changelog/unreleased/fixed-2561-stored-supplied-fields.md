- **A Memory write's `stored` and the `POST /FeedMemories` response report only request-supplied fields; no Memory or feed write response carries an embedding field (#2561).**

  `stored`, which a Memory POST, PUT or PATCH returns next to `redactedValues`
  (#2467), holds the string-valued text fields (`content`, `summary`,
  `trigger`) of that write's own request body, each with its stored (redacted)
  value. A text field the request did not send as a string is absent from
  `stored`. This includes a skill write that versions to a successor row: the
  successor carries over the fields its request omits, and `stored` reports
  only the ones the request sent. `redactedValues` counts the same values as
  before.

  The `POST /FeedMemories` response, built from the row the feed stored or
  matched, holds the non-null-valued fields the request supplied, each as
  stored, and the fields the server decides for that row: `id`, `agentId`,
  `durability`, `visibility`, `createdAt`, `updatedAt`, `expiresAt`,
  `archived`, `supersedes`, `skillSubjectId`, `instanceToken`,
  `originatorInstanceId` and `provenance` (plus `written` and `redactedValues`
  when present). Any other field the row holds, such as `metadata`, `subject`,
  `tags` or `contentHash`, is in the response only when the request sent it
  with a non-null value.

  No Memory or feed write response carries `embedding` or `embeddingModel`.
  The re-embed PATCH (body `{"embedding": null, "embeddingModel": null}`)
  answers `{ id, updatedAt }`, and the administrator `_reindex` re-PUT answers
  without either field. A write whose storage result is a successful
  `Response` answers with a `write_response_withheld` refusal (500) in its
  place, which says the write completed; the write paths' own refusals are
  named errors with no row fields. `flair reembed` counts a row as re-embedded
  when the PATCH response names that row and the stored row then carries the
  current model; it reads the model through the operations API when
  administrator credentials are set, and with a signed `GET /Memory/<id>` as
  the agent otherwise, and counts an unsuccessful or mismatched read as an
  error. A `flair reembed` from an earlier release reads the model from
  the PATCH response, so against this server it counts each row it
  re-embedded as an error; use the `flair reembed` of this release.

  The SDK write results and the built-in `/mcp` `memory_store` and
  `memory_update` echoes treat a `stored` with no string `content` as withheld
  (`contentWithheld: true`) and show no input text in its place.
