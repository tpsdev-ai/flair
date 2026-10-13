- **A non-admin addressed write is owner-checked and may name only the record it
  addresses.** A `POST`, `PUT`, `PATCH` or `DELETE` to `/<Table>/<id>` on an
  owner-scoped table is refused with
  `403 forbidden: cannot modify <Table> owned by another principal` when the
  addressed record exists and belongs to another principal; the owner is read
  from the stored record. On `POST`, `PUT` and `PATCH`, a request whose body
  names a different record than the one the URL addresses is refused with
  `403 write_id_not_addressed`.

  A non-admin `PUT`, `PATCH` or `DELETE` addressed to a table's collection rather
  than to one record is refused with
  `403 forbidden: a non-admin write to <Table> must address one record by its id`.
  Creating a record with `POST` to a collection stays governed by each
  resource's own create and attribution rules. Administrator writes and Flair's
  in-process server writes are unchanged, and a refused request writes nothing.

  > **Heads-up:** a custom non-admin integration that sends `PUT`, `PATCH` or
  > `DELETE` to a collection path (for example `/Memory/` or `/Relationship/?…`)
  > must write each record at `/<Table>/<id>` instead, with a body that names
  > that same record. Flair's own clients, CLI and adapters already write a
  > record at its own id, and create with `POST` to a collection (for example a
  > Presence heartbeat).
