- **`POST /RecordUsage` records usage only for memories the caller can read, and a non-admin `MemoryUsage` read shows a row only while its memory is readable.**
  The rule is the one `Memory.get` applies to a by-id read (`resolveReadScope`): the caller's own
  memories at any visibility, and other agents' non-private memories. An id outside that scope is
  handled exactly like an id that does not exist: the response is the same `{ "recorded": true }`,
  no ledger row is written for the caller, and the memory's `usageCount` does not change. The
  caller's scope is resolved once per call, and nothing is recorded if it cannot be resolved. The
  rule applies to every agent, admin agents included, and citation-on-write (`usedMemoryIds`)
  applies it through the same ledger core.

  A non-admin `GET /MemoryUsage/<id>` or collection read returns the caller's own rows about
  memories it can read; a row about a memory that is missing or out of its read scope reads as not
  found. Like a non-admin Memory read, a non-admin ledger read ignores the caller's
  `select`/`property`, and a collection `limit` can return fewer rows than it names. Admin and
  trusted internal ledger reads are unchanged.

  > **Heads-up:** a usage report counts only when the reporting agent can read the memory. A
  > `standard` or `ephemeral` memory defaults to private, so only its owner's reports count unless
  > it is written with `visibility: "shared"`.
