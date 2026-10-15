- **Owner-scoped addressed writes check body ids and stored ownership.**
  For non-admin writes through a table-extending resource, middleware can return
  `403 forbidden: cannot modify <Table> owned by another principal` first on
  `/<Table>/<id>` with no trailing slash or decoded `.`. If reached, the guard
  checks a differing scalar body `id` on `POST`/`PUT`/`PATCH` first
  (`403 write_id_not_addressed`), then stored ownership (the same owner refusal),
  using Harper's resolved record id. OrgEvent binds an addressed `POST`'s missing
  body `id` to the addressed id, including administrator and in-process calls.

  A non-admin `PUT`, `PATCH` or `DELETE` addressed to a table's collection
  rather than to one record is refused with
  `403 forbidden: a non-admin write to <Table> must address one record by its id`.
  A `POST` to a collection is delegated to each resource's own `POST`
  handling. The guard exempts administrator and in-process calls. A refusal
  by this guard leaves its target row unchanged.

  > **Heads-up:** a non-admin `PUT`, `PATCH` or `DELETE` must use an addressed
  > path (`/<Table>/<id>`) rather than a collection path such as `/Memory/` or
  > `/Relationship/?…`, and a scalar body `id` supplied with an addressed
  > `POST`, `PUT` or `PATCH` must match Harper's resolved record id.
