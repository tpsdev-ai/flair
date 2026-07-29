- **Soul entries are owner-scoped on every write verb.** Only a principal (or an
  administrator) may write its own soul entries. That rule was enforced by a
  guard with two independent gaps, either of which alone let any verified agent
  rewrite or delete another agent's identity data: it ran on `PUT` and `POST`
  but not `PATCH` or `DELETE`, and it compared the `agentId` in the request body
  rather than the owner of the record being written — so a body that simply
  omitted the field was checked against nothing.

  Both are closed. The guard now runs on every mutating verb and resolves
  ownership from the stored record named in the path. Writing your own soul is
  unchanged, and administrators are unaffected.
