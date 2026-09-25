- **The instance-identity readers see every row and never invent one, and a failure to read is an error.**

  Four ways the instance could still end up with two identity rows, or with a
  reader reporting an identity it does not have (flair#1883).

  **The read is unconditional.** Every instance-identity reader reads
  `flair.Instance` with one unconditional statement — `SELECT id, role,
  publicKey, status, createdAt FROM flair.Instance` — because a
  `search_by_conditions` needs at least one condition, and a condition is
  exactly what hides a row. (`createdAt` is REQUIRED by the schema —
  `createdAt: String! @indexed` — so no legal row omits it; the date-shaped
  `createdAt > "1970-01-01"` "select all" is the pattern the Agent and Memory
  readers carry (`src/commands/agent.ts`, `src/commands/memory.ts`), and a row
  that compares below it would be invisible to any read shaped that way.)

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
  costs.** An id that names no row is refused whatever the table holds: with zero
  or one row there is nothing to delete either, but a typo would otherwise read as
  a successful prune of the row the operator meant to keep. And a prune that is
  about to delete rows warns that a paired peer must re-pair when the identity it
  pinned is one of them.

  (Refs #1883)
