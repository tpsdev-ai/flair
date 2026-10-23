- **Owner DELETE, and an untagged owner POST naming an id or a `supersedes` target, take the per-id Memory write lock.**

  Past the refusals that need no row, a `DELETE /Memory/<id>` reads the row with
  no lock held, then takes the id's lock, which covers its authorization, its
  write and its owned transaction's commit. Deleting a skill row closes the
  skill's live head, which for an older version is another row: the DELETE locks
  that head too, and when the head it reads under the locks is not one it holds,
  it writes nothing and tries again, at most 3 attempts in all, then answers
  `503 memory_busy`.
  Unless it is submitted with the skill tag, a `POST /Memory` that names an id
  or a `supersedes` reference takes the lock for each id it names, the reference
  under the id it resolves to, and holds it across its read, decision and write
  and the superseded row's close; an untagged POST naming a skill row takes it
  and then inherits the tag. Its non-skill row writes join an open request
  transaction, which commits after the lock is released. The DELETE, or a POST
  that takes the lock, writes nothing and answers `503 memory_busy` when it
  cannot acquire the lock within the owner wait budget,
  `503 write_outcome_unknown` for an id whose last write has an unresolved
  outcome, and `503 memory_lock_unavailable` when the store has no lock.
