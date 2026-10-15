- **A non-admin addressed write is owner-checked, and a scalar body id must name
  the addressed record.** On an owner-scoped table served by a resource that
  extends it, a `POST`, `PUT`, `PATCH` or `DELETE` to `/<Table>/<id>` is
  refused with `403 forbidden: cannot modify <Table> owned by another principal`
  when the addressed record exists and belongs to another principal; the owner
  is read from the stored record. On `POST`, `PUT` and `PATCH`, a body whose
  scalar `id` (a string or number) names a different record than the URL is
  refused with `403 write_id_not_addressed`. OrgEvent binds an addressed
  `POST`'s missing body `id` to the addressed id, including administrator and
  in-process calls.

  A non-admin `PUT`, `PATCH` or `DELETE` addressed to a table's collection
  rather than to one record is refused with
  `403 forbidden: a non-admin write to <Table> must address one record by its id`.
  A `POST` to a collection is delegated to each resource's own `POST`
  handling. The guard exempts administrator and in-process calls. A refusal
  by this guard leaves its target row unchanged.

  > **Heads-up:** a non-admin `PUT`, `PATCH` or `DELETE` must use an addressed
  > path (`/<Table>/<id>`) rather than a collection path such as `/Memory/` or
  > `/Relationship/?…`, and a scalar body `id` supplied with an addressed
  > `POST`, `PUT` or `PATCH` must match that path's id.
