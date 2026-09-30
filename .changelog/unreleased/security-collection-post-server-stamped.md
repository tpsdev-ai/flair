- **A non-admin HTTP collection `POST` is served only by a resource's own `post()`, and Relationship has one.**

  `POST /Relationship/` runs the same preparation as `PUT /Relationship/<id>`.
  For a verified non-admin agent, the owner is that agent (a body that names
  another agent is refused with 403); an administrator or in-process caller
  keeps the owner it supplies, and must supply one, as with `PUT`. The
  preparation can refuse the write (with 401, 403, 429 or 400); a write that
  passes it is normalized, gets `provenance` built server-side, and has
  `originatorInstanceId` stamped as a create. A create that is otherwise
  admitted, valid and within the rate limit answers 409 when its id already
  exists, so a `POST` never updates a row.

  On a table whose resource defines no `post()` of its own, a collection `POST`
  from a non-admin HTTP caller is refused. The resource's `allowCreate()` check
  runs first and can refuse it; otherwise the guard answers 403 for a verified
  agent and 401 for a caller without a valid credential, and refuses a caller
  it cannot resolve. Administrator and in-process `POST`s to such a table are
  unchanged. Existing `post()` overrides are unchanged, and each keeps its own
  write rules. The Flair client, the CLI and the MCP adapter create
  relationships with `PUT /Relationship/<id>` and are unaffected.
