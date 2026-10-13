- **An OrgEvent's `createdAt` is assigned by the server on create and cannot be changed.**

  `POST`, `PUT` (one record, a collection `PUT` of an array, or an array body)
  and a `PATCH` that creates a row store the server's time, whatever the body
  says, for agents and admin agents alike. An update that omits `createdAt`
  keeps the stored value, so `PUT /OrgEvent/<id>` no longer needs it in the
  body. An update that is otherwise admitted and reaches the timestamp check
  with a different `createdAt` is refused with 409 `created_at_immutable`, and
  nothing in that request is written; an earlier check (authentication,
  ownership, attribution, entity validation) answers with its own response
  first. The check reads the stored row after those checks and before the
  write, not atomically with it: a row first written between the two is
  treated as a create and gets the server's time. If that read fails, the write
  is refused with 503 `created_at_check_unavailable` and nothing is written.
  Other read failures also refuse the write and keep their existing responses:
  503 `owner_check_unavailable` from a non-admin POST's ownership lookup, and
  Harper's 500 when an addressed PUT or PATCH cannot load its row. Trusted
  in-process writers that supply their own `createdAt`, such as the migration
  ledger, write through the table and are unchanged.

  > **Heads-up:** a client that re-sends an existing event with a different
  > `createdAt` now receives 409 instead of a stored change, when no earlier
  > check refuses the write first. Omit `createdAt` on updates.
