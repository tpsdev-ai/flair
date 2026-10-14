- **A non-admin addressed write is owner-checked, and a scalar body id must name
  the addressed record.** On an owner-scoped table served by a resource that
  extends it, a `POST`, `PUT`, `PATCH` or `DELETE` to `/<Table>/<id>` is
  refused with `403 forbidden: cannot modify <Table> owned by another principal`
  when the addressed record exists and belongs to another principal; the owner
  is read from the stored record. On `POST`, `PUT` and `PATCH`, a body whose
  scalar `id` (a string or number) names a different record than the URL is
  refused with `403 write_id_not_addressed`. An OrgEvent `POST` addressed to a
  record with no body `id` now writes the addressed record.

  A non-admin `PUT`, `PATCH` or `DELETE` addressed to a table's collection
  rather than to one record is refused with
  `403 forbidden: a non-admin write to <Table> must address one record by its id`.
  A `POST` to a collection is delegated to each resource's own `POST`
  handling. Administrator writes and Flair's in-process server writes are
  unchanged, and a refused write leaves its target row unchanged.

  > **Heads-up:** a non-admin `PUT`, `PATCH` or `DELETE` must use an addressed
  > path (`/<Table>/<id>`) rather than a collection path such as `/Memory/` or
  > `/Relationship/?…`, and a scalar body `id` supplied with an addressed
  > `POST`, `PUT` or `PATCH` must match that path's id.
