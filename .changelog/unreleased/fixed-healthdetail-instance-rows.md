- **`/HealthDetail` reports a refusal, not a coin-toss pick, when several Instance rows exist, and marks a failed read unreadable, not absent.**

  Before this, `federation.instance` answered with whatever row `flair.Instance.search` happened to yield first — an arbitrary pick when the table held more than one row — and a read that threw was swallowed as "absent", so a storage failure made the detail read as a healthy, identity-less instance rather than as unreadable.

  It now reads the Instance rows the same way `GET /FederationInstance` does (through the strict reader that refuses a row it cannot name) and decides the answer from every row it can see: exactly one row is reported as `{ id, role, status }`, with an absent `role` or `status` reported as `null`; no rows is `null` (unchanged); several rows is a refusal that names the prune command instead of the row the search yielded first; and a read that fails, or a row the reader cannot name, is reported as `{ unreadable: true }` — never `null` and never a pick.

  For an admin, the several-rows refusal also lists every row's `id`, `role` and `createdAt`; a non-admin sees only the count and the prune command.

   (Refs #1896)
