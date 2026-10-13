- **Every non-admin write is owner-checked for each record it writes.** A request
  that would write a record the caller does not own is refused with
  `403 forbidden: cannot modify <Table> owned by another principal`, however the
  request addresses that record. The owner is read from the stored record.

  A non-admin PUT, PATCH or DELETE addressed to a table's collection rather than
  to one record is now refused with
  `403 forbidden: a non-admin write to <Table> must address one record by its id`.
  Flair's own clients, CLI and adapters write one record at a time by id and are
  unaffected. Collection POST (create), administrator writes and Flair's
  in-process server writes are unchanged. A refused request writes nothing.

  > **Heads-up:** a custom non-admin integration that sends PUT, PATCH or DELETE
  > to a collection path (for example `/Memory/` or `/Relationship/?…`) must
  > write each record at `/<Table>/<id>` instead.
