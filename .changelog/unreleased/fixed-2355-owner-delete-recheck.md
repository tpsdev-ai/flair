- **A non-admin owner-scoped delete refuses a row whose owner changed before it commits.**
  `Memory`, `Credential`, `MemoryGrant`, `WorkspaceState`, `MemoryCandidate` and
  `Relationship` deletes re-read the row in a transaction the delete owns and
  confirm the committed row's owner before the row is removed. A row whose owner
  changed after that read is refused with the named 409 (`owner_changed`) and
  left in place; a row whose owner is unchanged is deleted as before.
