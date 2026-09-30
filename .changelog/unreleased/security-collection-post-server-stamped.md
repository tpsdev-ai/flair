- **A collection `POST` creates a row through the resource's own `post()`, or for an administrator.**

  `POST /Relationship/` runs the same preparation as `PUT /Relationship/<id>`:
  the owner is the authenticated agent (a body that names another agent is
  refused with 403), the triple is validated and normalized, `provenance` is
  built server-side, and `originatorInstanceId` is stamped as a create. An id
  that already exists answers 409, so a `POST` never updates a row.

  On a table whose resource defines no `post()` of its own, a collection `POST`
  from a verified agent that is not an administrator answers 403, and one
  without a valid credential answers 401. Administrator and in-process writes
  are unchanged. The Flair client, the CLI and the MCP adapter create
  relationships with `PUT /Relationship/<id>` and are unaffected.
