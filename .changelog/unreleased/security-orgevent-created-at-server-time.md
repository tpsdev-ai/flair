- **The server assigns an OrgEvent's `createdAt` on create, and a write that reaches the `createdAt` check cannot change a stored value.**

  `POST` and a single-record `PUT` store the server's time, whatever the body
  says, for agents and administrators alike. An administrator's collection `PUT`
  of an array, an administrator's array-body `PUT`, and an administrator's
  `PATCH` that creates a row do the same; a non-admin agent's array-body `PUT`
  is refused earlier, by attribution, and stores nothing.

  The check runs after the earlier checks (authentication, ownership,
  attribution, entity validation), which answer first with their own
  responses, as Harper's own validation does for input it refuses before the
  resource runs. An event that reaches the check and is not an object, or
  whose id is not a non-empty string or a non-empty array of strings, is
  refused with 400 `invalid_event_id` and nothing is written. At the root
  collection, `POST` generates an id when the body's id is missing, `null` or
  empty. An addressed `POST` binds a body id equal as text to the addressed
  id before validation. At `POST` id validation, at the root collection or an
  addressed path whose body id differs as text from the addressed id, a
  remaining id that is not a non-empty string or a non-empty array of strings
  receives the same 400 before the ownership lookup. An administrator's
  `PATCH` to the collection names no id and is refused the
  same way; a non-admin's collection `PUT` or `PATCH` is refused earlier by
  the owner-scoped write guard. Otherwise the check reads the stored row under
  the event's id. A stored row's `createdAt` is authoritative whatever its
  value, an empty string included: an update that omits `createdAt` keeps it,
  so `PUT /OrgEvent/<id>` no longer needs it in the body, and an update that
  names a different value is refused with 409 `created_at_immutable`, and
  nothing in that request is written.

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
  > non-empty array of strings receives 400 `invalid_event_id`. `POST` binds
  > matching addressed body ids before validation; at `POST` id validation,
  > at the root collection or an addressed path whose body id differs as text
  > from the addressed id, a remaining id outside those shapes receives the same 400.
