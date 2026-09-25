- **The instance-identity readers see every row and never invent one, and a failure to read is an error.**

  Four ways the instance could still end up with two identity rows, or with a
  reader reporting an identity it does not have (flair#1883 round 2).

  **The read is unconditional.** `flair init --remote` and the doctor probe read
  `flair.Instance` through an ops-API `search_by_conditions` carrying
  `createdAt > "1970-01-01"` — so every row whose `createdAt` compares below that
  string (a date before 1970, an empty string) was invisible, and init then
  inserted a second identity next to the one it could not see. (`createdAt` is
  REQUIRED by the schema — `createdAt: String! @indexed` — so no legal row omits
  it; the date-shaped filter was the wrong instrument all the same, because it
  could hide a row the table is allowed to hold.) The read is now one
  unconditional statement, `SELECT id, role, publicKey, status, createdAt FROM
  flair.Instance`; a `search_by_conditions` needs at least one condition, and a
  condition is exactly what hides a row.

  **A failed read is not first boot.** `GET /FederationInstance` used to log a
  read error and fall through to its create branch, minting a fresh identity row
  on every call while the store was unreadable — the same defect, entered from the
  server side. It now answers 503 and creates nothing: only a successful read
  that returns zero rows creates.

  **After it writes, init re-reads.** The read-then-insert window is real, and a
  concurrent `GET /FederationInstance` lands in it. Both the create and the
  role-update paths now re-read and, on finding several rows, fail with the
  refusal that names every row and the prune — instead of reporting a successful
  init over a table that has no single identity.

  **`prune` refuses an unknown `--keep` at every row count, and says what a delete
  costs.** An id that names no row was accepted as "nothing to do" whenever the
  table held at most one row, so a typo read as a successful prune of the row the
  operator meant to keep; it is now refused whatever the count. And a prune that
  is about to delete rows warns that a paired peer must re-pair when the identity
  it pinned is one of them.

  (Refs #1883)
