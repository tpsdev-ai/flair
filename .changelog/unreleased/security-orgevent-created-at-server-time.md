- **The server assigns an OrgEvent's `createdAt` on create, and a write that reaches the `createdAt` check cannot change a stored value.**

  `POST`, `PUT` (one record, a collection `PUT` of an array, or an array body)
  and an administrator's `PATCH` that creates a row store the server's time,
  whatever the body says, for agents and administrators alike.

  The check runs after the earlier checks (authentication, ownership,
  attribution, entity validation), which answer first with their own
  responses, as Harper's own validation does for input it refuses before the
  resource runs. An event that reaches the check and is not an object, or
  whose id is not a non-empty string or a non-empty array of strings, is
  refused with 400 `invalid_event_id` and nothing is written; `POST` generates
  an id before the check when the body's id is missing, empty, `null`, `0` or
  `false`. A `PATCH` to the collection names no id and is refused the same
  way. Otherwise the check reads the stored row under the event's id. A stored
  row's `createdAt` is authoritative whatever its value, an empty string
  included: an update that omits `createdAt` keeps it, so `PUT /OrgEvent/<id>`
  no longer needs it in the body, and an update that names a different value
  is refused with 409 `created_at_immutable`, and nothing in that request is
  written.

  The read comes before the write, not atomically with it: a row first written
  between the two is treated as a create and gets the server's time. If the
  check's own read fails, the write is refused with 503
  `created_at_check_unavailable` and nothing is written. Other read failures
  also refuse the write with their existing responses: the owner guard's
  `owner_check_unavailable` for a non-admin `POST`'s ownership lookup (400 when
  the read fails with a 4xx error, otherwise 503), and Harper's 500 when an
  addressed `PUT` or `PATCH` cannot load its row. Trusted in-process writers
  that supply their own `createdAt`, such as the migration ledger, write
  through the table and are unchanged.

  > **Heads-up:** when no earlier check refuses the write first, a client that
  > re-sends an existing event with a different `createdAt` now receives 409
  > instead of a stored change (omit `createdAt` on updates), and a write whose
  > event reaches the check with an id that is not a non-empty string or a
  > non-empty array of strings now receives 400 `invalid_event_id`.
