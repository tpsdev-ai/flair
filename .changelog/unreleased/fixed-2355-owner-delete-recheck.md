- **A non-admin owner-scoped delete rechecks the committed row's owner.**
  `Memory`, `Credential`, `MemoryGrant`, `WorkspaceState`, `MemoryCandidate` and
  `Relationship` deletes re-read the row and confirm the committed row's owner
  before the write; Memory's ordinary delete runs through
  withSharedWriteTransaction, which joins a request-owned transaction when one
  exists. A row whose owner had changed by that confirmation read is refused
  with the named 409 (`owner_changed`) and left in place; a row whose owner is
  unchanged is handled as before.
