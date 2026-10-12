- **`flair agent stamp-home` and `flair principal add` never change a stored Agent home (#2472, #2473, #2474).**

  `flair agent stamp-home --apply` now decides inside a FRESH OWNED transaction in
  the Agent resource: it re-reads the row in a scope the request's pinned read
  snapshot does not pin, stamps this instance's OWN id only when the row, at
  write time, is still home-less and carries no federation-sync provenance,
  re-reads the COMMITTED row before staging, names only the home field, and never
  creates (a gone row is refused). A row that is ineligible — already homed, or
  carrying provenance — is returned as an explicit skip with no write and no
  `updatedAt` change. The CLI reports a row `stamped` only when the resource
  confirms it APPLIED the stamp, never from a read-back that merely shows this
  instance's home (another writer may have set it).

  `flair principal add` is create-only and puts the resolved home on the `insert`
  itself, so a row created at write time — including one deleted since the read —
  carries it; an existing row's stored home stands. A row that appears with a home
  that differs from this instance's is refused with `originator_instance_immutable`,
  never silently updated, and a write the operations API skips fails by name.

  `flair agent stamp-home` addresses ONE instance: the ops port and the HTTP port
  are paired (the instance's own config is the authority), and an explicit
  `--ops-port` that disagrees with that pair is refused with
  `ambiguous_instance_target`.

  The seed-based creation-path coverage test now checks the EXECUTED call site, so
  a local `flair init`/`flair import` that switched to the home-less seed fails.
