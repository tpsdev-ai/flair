- **`flair agent stamp-home` and `flair principal add` never change a stored Agent home (#2472, #2473, #2474).**

  `flair agent stamp-home --apply` now decides inside a FRESH OWNED transaction in
  the Agent resource: it resolves this instance's own id first, re-reads the row
  in a scope the request's pinned read snapshot does not pin, STAGES the
  home-only write when the row is still home-less and carries no federation-sync
  provenance, then re-reads the COMMITTED row and ABORTS (discarding the staged
  write) if that row gained a home or provenance, or is gone — so a row deleted
  since the caller's read is never re-created, and an ineligible row is returned
  as an explicit skip with no write and no `updatedAt` change. When there is no
  canonical Instance row (none, or several) there is no id to stamp: the write is
  refused by name inside the resource, before any PATCH. The CLI reports a row
  `stamped` only when the resource confirms it APPLIED the stamp, never from a
  read-back that merely shows this instance's home (another writer may have set it).

  `flair principal add` is create-only and puts the resolved home on the `insert`
  itself, so a row created at write time — including one deleted since the read —
  carries it; an existing row's stored home stands. The write-back that follows a
  SKIPPED insert goes to the Agent resource, where it stages the update and then
  aborts (`originator_instance_immutable`) when the committed row's home became a
  peer's — so a row this command did not create is never changed.

  `flair agent stamp-home` addresses ONE instance: the ops port and the HTTP port
  are paired (the instance's own config is the authority), an explicit `--ops-port`
  that disagrees with that pair is refused, and an HTTP port that disagrees with the
  pair its derived ops port came from is refused too — both with
  `ambiguous_instance_target`.

  Harper has no compare-and-set: a home or provenance committed after that
  confirmation and before the transaction's commit is still not seen (the residual
  window; per-id serialization is tracked as #2478).

  The seed-based creation-path coverage test now names the local `flair init` path
  as its one uncovered gap (only `--remote` is asserted at row level).
