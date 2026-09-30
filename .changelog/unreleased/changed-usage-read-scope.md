- **`POST /RecordUsage` counts only memories in the caller's read scope, and a non-admin `MemoryUsage` read shows a row only while its memory is readable.**
  The read scope is `resolveReadScope`, the rule a non-admin by-id `Memory.get` applies: the
  caller's own memories at any visibility, and other agents' non-private memories. It applies to
  every agent, admin agents included, although an admin's Memory reads are unfiltered, and
  citation-on-write (`usedMemoryIds`) applies it through the same ledger core. An id outside that
  scope is handled like an id that does not exist: the response is the same
  `{ "recorded": true }` and the memory's `usageCount` does not change. The scope is checked on the
  first read of the memory, before a ledger row is written, so an id outside it there gets no
  ledger row for the caller. A memory that leaves the scope before the re-read that precedes the
  count bump keeps the ledger row already written, and its count is not bumped. The caller's scope
  is resolved once per call, and nothing is recorded if it cannot be resolved.

  A non-admin `GET /MemoryUsage/<id>` or collection read returns the caller's own rows about
  memories it can read; a row about a memory that is missing or out of its read scope reads as not
  found. Like a non-admin Memory read, a non-admin ledger read ignores the caller's
  `select`/`property`, and a collection `limit` can return fewer rows than it names. Admin and
  trusted internal ledger reads are unchanged.

  > **Heads-up:** a usage report counts only when the memory is in the reporting agent's read
  > scope. A `standard` or `ephemeral` memory defaults to private, so only its owner's reports count
  > unless it is written with `visibility: "shared"`.
