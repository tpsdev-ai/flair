- **An OrgEvent's `createdAt` is assigned by the server on create and cannot be changed through the OrgEvent write verbs.**

  `POST`, `PUT` (one record, a collection `PUT` of an array, or an array body)
  and a `PATCH` that creates a row store the server's time, whatever the body
  says, for agents and admin agents alike. An update that omits `createdAt`
  keeps the stored value, so `PUT /OrgEvent/<id>` no longer needs it in the
  body. After the earlier checks (authentication, ownership, attribution,
  entity validation), which answer with their own responses first, the check
  reads the stored row under each event's id. An event that is not an object,
  or whose id is not a non-empty string or a non-empty array of strings, is not
  read: the write is refused with 400 `invalid_event_id` and nothing in it is
  written. A `PATCH` to the collection names no id and is refused the same
  way. An update that reaches the timestamp check with a different `createdAt`
  is refused with 409 `created_at_immutable`, and nothing in that request is
  written. The read comes before the write, not atomically with it: a row
  first written between the two is treated as a create and gets the server's
  time. If that read fails, the write is refused with 503
  `created_at_check_unavailable` and nothing is written. Other read failures
  also refuse the write and keep their existing responses: 503
  `owner_check_unavailable` from a non-admin POST's ownership lookup, and
  Harper's 500 when an addressed PUT or PATCH cannot load its row. Trusted
  in-process writers that supply their own `createdAt`, such as the migration
  ledger, write through the table and are unchanged.

  > **Heads-up:** a client that re-sends an existing event with a different
  > `createdAt` now receives 409 instead of a stored change, when no earlier
  > check refuses the write first; omit `createdAt` on updates. A write naming
  > an event id that is not a non-empty string or a non-empty array of strings
  > now receives 400 `invalid_event_id`.
