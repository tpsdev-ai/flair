- **`flair agent stamp-home` and `flair principal add` guard a stored Agent home on their write paths (#2472, #2473, #2474).**

  `flair agent stamp-home --apply` now decides inside a FRESH OWNED transaction in
  the Agent resource (the request's own transaction is detached for that scope):
  it resolves this instance's own id first, re-reads the row in a scope the
  request's pinned read snapshot does not pin, STAGES the home-only write when the
  row is still home-less and carries no federation-sync provenance, then re-reads
  the COMMITTED row and ABORTS (discarding the staged write) if that row gained a
  home or provenance, or is gone — so a row deleted since the caller's read is
  never re-created, and an ineligible row is returned as an explicit skip with no
  write and no `updatedAt` change. When there is no canonical Instance row (none,
  or several) there is no id to stamp: the write is refused by name inside the
  resource, before any PATCH. The CLI reports a row `stamped` only when the
  resource confirms it APPLIED the stamp, never from a read-back that merely shows
  this instance's home (another writer may have set it).

  `flair principal add` assigns a home only on the `insert` it creates: the
  resolved home rides on that insert, so a row created at write time — including
  one deleted since the read — carries it, and an existing row's stored home
  stands. The write-back that follows a SKIPPED insert goes to the Agent resource,
  which writes back only an EXPLICIT ALLOW-LIST of fields — never a home and never
  a federation stamp, whatever the body carried — stages the update in a fresh
  owned transaction, then aborts (`originator_instance_immutable`) when the
  committed row's home became a peer's and (`agent_principal_write_back_no_row`)
  when it is gone. Other fields of an existing row (its display name, trust tier,
  runtime) are still updated; the stored home is not, and a deleted row is not
  re-created. That write-back is honoured only for an administrator or a trusted
  internal call; every other caller takes the ordinary PATCH path, which strips a
  client-supplied home and the federation bookkeeping.

  `flair agent stamp-home` and `flair principal add` each address ONE instance:
  the ops port and the HTTP port are paired against the instance's own config. A
  CONFIGURED pair is checked — an explicit `--ops-port` that disagrees with it is
  refused, and an HTTP port that disagrees with the pair its derived ops port came
  from is refused too, both with `ambiguous_instance_target`. A pair the caller
  names for BOTH ports is trusted without verification.

  Harper has no compare-and-set: a home or provenance committed after that
  confirmation and before the transaction's commit is still not seen (the residual
  window; per-id serialization is tracked as #2478).

  The home-writer coverage test checks the seed call sites it names by file
  (`src/commands/agent.ts`, `src/commands/init.ts`, `src/commands/import.ts`) by
  text; the local `flair init` row is its one uncovered gap (only `--remote` is
  asserted at row level).
