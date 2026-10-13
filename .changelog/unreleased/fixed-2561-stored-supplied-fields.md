- **A Memory write's `stored` and the `POST /FeedMemories` response report only the fields the request supplied; embedding fields are never returned (#2561).**

  `stored`, which a Memory POST, PUT or PATCH returns next to `redactedValues`
  (#2467), holds exactly the `content`, `summary` and `trigger` fields present
  in that write's own request body, each with its stored (redacted) value. A
  text field the request did not send is absent from `stored`. This includes a
  skill write that versions to a successor row: the successor carries over the
  fields its request omits, and `stored` reports only the ones the request
  sent. `redactedValues` counts the same values as before.

  The `POST /FeedMemories` response, built from the row the feed stored or
  matched, holds the fields the request supplied, each as stored, and the
  fields the server decides for that row: `id`, `agentId`, `durability`,
  `visibility`, `createdAt`, `updatedAt`, `expiresAt`, `archived`,
  `supersedes`, `skillSubjectId`, `instanceToken`, `originatorInstanceId` and
  `provenance` (plus `written` and `redactedValues` when present). Any other
  field the row holds, such as `metadata`, `subject`, `tags` or
  `contentHash`, is in the response only when the request sent it. No Memory
  or feed write response carries `embedding` or `embeddingModel`. The SDK
  write results and the MCP write replies already treat a `stored` with no
  `content` as withheld (`contentWithheld: true`) and never show the input in
  its place.
