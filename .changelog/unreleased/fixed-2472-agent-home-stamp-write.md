- **`flair agent stamp-home` and `flair principal add` guard a stored Agent home on their write paths (#2472, #2473, #2474).**

  `flair agent stamp-home --apply` now decides inside a FRESH OWNED transaction in
  the Agent resource (the request's own transaction is detached for that scope).
  It reads this instance's id from the CURRENT `Instance` table there — a fresh
  read, not a process-cached id — and when that read finds no canonical Instance
  row (none, or several) the write is refused by name
  (`agent_home_stamp_no_instance`) with nothing written. It then reads the row,
  STAGES the home-only write when the row is still home-less and carries no
  federation-sync provenance, re-reads the COMMITTED row, and ABORTS (discarding
  the staged write) if that read sees a home or provenance, or no row. A row
  either read finds deleted is not re-created, and an ineligible row is returned
  as an explicit skip with no write and no `updatedAt` change. The CLI reports a
  row `stamped` only when the resource confirms it APPLIED the stamp, never from
  a read-back that merely shows this instance's home (another writer may have set
  it).

  `flair principal add` assigns a home only on the `insert` it creates: the
  resolved home rides on that insert, so a row created at write time — including
  one deleted since the read — carries it, and an existing row's stored home
  stands. The write-back that follows a SKIPPED insert goes to the Agent resource,
  which writes back only an EXPLICIT ALLOW-LIST of fields — never a home and never
  a federation stamp, whatever the body carried — stages the update in a fresh
  owned transaction, and refuses with `originator_instance_immutable` when its
  owned read or its confirmation read sees the row's home as a peer's, and with
  `agent_principal_write_back_no_row` when either read finds the row gone. Other
  fields of an existing row (its display name, trust tier, runtime) are still
  updated; the stored home is not, and a row those reads find deleted is not
  re-created. That write-back is honoured only for an administrator or a trusted
  internal call; an authorized non-admin PATCH caller that sends it takes the
  ordinary PATCH path, which strips a client-supplied home and the federation
  bookkeeping.

  `flair agent stamp-home` and `flair principal add` pair the ops port and the
  HTTP port against the ports the instance's config records. With a complete
  configured pair, a port that matches its side binds the other to that pair: a
  target where exactly one of the two matches is refused, and a port left out is
  taken from the pair. With no complete configured pair, a target that names only
  one of the two ports is refused. Both refusals are `ambiguous_instance_target`
  and come before the command contacts either port. Two ports the caller names
  that match neither side of the configured pair (or when there is no complete
  pair) are used as given, without verification.

  Harper has no compare-and-set: a home or provenance committed, a deletion, or an
  `Instance` table change made after the read that checked it and before the
  transaction's commit is still not seen (the residual window; per-id
  serialization is tracked as #2478).

  The home-writer coverage test checks the seed call sites it names by file
  (`src/commands/agent.ts`, `src/commands/init.ts`, `src/commands/import.ts`) by
  text; the local `flair init` row is its one uncovered gap (only `--remote` is
  asserted at row level).
