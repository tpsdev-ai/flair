- **An OrgEvent's `createdAt` is assigned by the server on create and cannot be changed.**

  `POST`, `PUT` (one record, a collection `PUT` of an array, or an array body)
  and a `PATCH` that creates a row store the server's time, whatever the body
  says, for agents and admin agents alike. An update that omits `createdAt`
  keeps the stored value, so `PUT /OrgEvent/<id>` no longer needs it in the
  body. An update whose `createdAt` differs from the stored value is refused
  with 409 `created_at_immutable`, and nothing in that request is written. The
  stored row is read before the write, not atomically with it: a row first
  written between the two is treated as a create and gets the server's time.
  If that read fails, the write is refused and nothing is written. Trusted
  in-process writers that supply their own `createdAt`, such as the migration
  ledger, write through the table and are unchanged.

  > **Heads-up:** a client that re-sends an existing event with a different
  > `createdAt` now receives 409 instead of a stored change. Omit `createdAt`
  > on updates.
