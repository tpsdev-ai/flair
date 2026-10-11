- **`flair agent stamp-home` and `flair principal add` never change a stored Agent home (#2472, #2473).**

  `flair agent stamp-home --apply` now decides inside the Agent resource's write
  transaction: it stamps a row only when the row, at write time, is still
  home-less and carries no federation-sync provenance, names only the home
  field, and reports a row stamped only after reading it back. A row that gained
  a home or provenance meanwhile is listed, not written, and a row that is gone
  is not re-created.

  `flair principal add` is create-only: a new row's home is written by an
  `insert`; a row that already exists is written back without the home field, and
  a stored home that differs from this instance's is refused with
  `originator_instance_immutable`.
