- **Memory `stored` holds only request-supplied text fields; `POST /FeedMemories` returns non-null request-supplied Memory attributes plus listed response fields; no write response carries embedding fields (#2561).**

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
  stored, plus these listed response fields of that row: `id`, `agentId`,
  `durability`, `visibility`, `createdAt`, `updatedAt`, `expiresAt`,
  `archived`, `supersedes`, `skillSubjectId`, `instanceToken`,
  `originatorInstanceId` and `provenance` (plus `written` and `redactedValues`
  when present). Any other field the row holds, such as `metadata`, `subject`,
  `tags` or `contentHash`, is in the response only when the request sent it
  with a non-null value.

  No Memory or feed write response holds a key named `embedding` or
  `embeddingModel`, at any depth. The re-embed PATCH (body
  `{"embedding": null, "embeddingModel": null}`) answers `{ id, updatedAt }`.
  A Memory POST, PUT or PATCH, a `_reindex` re-PUT and a feed write return
  either a refusal they built (a named error with no row fields) or a fresh
  plain-JSON copy of their response: each property is read once from its
  descriptor, and the copy holds only plain objects, arrays, strings, finite
  numbers, booleans and null, and neither key. The POST, PUT, PATCH and
  `_reindex` results are reported only when they have no value or are a
  row-shaped record (a plain object with only Memory attributes and
  `written`) or an array of them; the feed copies only a row (an object with
  an own `id` and only data properties: a plain object or a Harper record).
  Anything else, such as a wrapper around a row, a nested embedding key, an
  accessor, a typed array, a Date, a scalar, a successful `Response` or an
  absent feed result, is answered with a `write_response_withheld` refusal
  (500). So is a `Response` from the storage layer, whatever its status. The
  refusal echoes no field of the result, does not say whether the write was
  stored, and asks the caller to read the row. The feed copy holds the listed
  response fields and the non-null Memory attributes the request supplied,
  plus `redactedValues` when present. `flair reembed` counts a row as re-embedded
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
