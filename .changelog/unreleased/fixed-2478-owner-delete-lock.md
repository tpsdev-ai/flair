- **Owner DELETE and owner POST take the per-id Memory write lock.**

  A `DELETE /Memory/<id>` takes the id's lock before the reads it decides on
  and holds it across its owned transaction's commit. Deleting a skill row
  closes the skill's live head, which for an older version is another row: the
  DELETE locks that head too, and when the head changes before the DELETE reads
  it under the locks, it writes nothing and tries again, at most 3 attempts in
  all, then answers `503 memory_busy`.
  A `POST /Memory` takes the lock for each id it names, a `supersedes`
  reference under the id it resolves to, and holds it across its read,
  decision and write and the superseded row's close. The POST joins the
  request's open transaction, which commits after the lock is released. A
  skill POST takes no lock. While another writer holds an id past the owner
  wait budget, the DELETE or POST answers `503 memory_busy` and writes nothing.
