- **A non-admin HTTP collection `POST` is served only by a resource's own `post()`, and Relationship has one.**

  `POST /Relationship/` runs the same preparation as `PUT /Relationship/<id>`.
  For a verified non-admin agent, the owner is that agent (a body that names
  another agent is refused with 403); an administrator or in-process caller
  keeps the owner it supplies, as with `PUT`. For every caller admitted, the
  triple is validated and normalized, `provenance` is built server-side, and
  `originatorInstanceId` is stamped as a create. An id that already exists
  answers 409, so a `POST` never updates a row.

  On a table whose resource defines no `post()` of its own, a collection `POST`
  from a verified agent that is not an administrator answers 403, and one
  without a valid credential answers 401; administrator and in-process `POST`s
  to such a table are unchanged. Existing `post()` overrides are unchanged, and
  each keeps its own write rules. The Flair client, the CLI and the MCP adapter
  create relationships with `PUT /Relationship/<id>` and are unaffected.
