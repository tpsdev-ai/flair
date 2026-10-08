- **A non-admin owner-scoped delete rechecks the committed row's owner.**
  `Memory`, `Credential`, `MemoryGrant`, `WorkspaceState`, `MemoryCandidate` and
  `Relationship` deletes by a non-admin caller re-read the row and confirm that
  its committed owner is still the caller before the write. A skill-tagged
  `Memory` delete closes the subject's live head, which a stale id resolves to a
  different row; for a non-admin caller it also confirms that the head's
  committed owner is the one its transaction read. A row whose owner fails a
  confirmation is refused with the named 409 (`owner_changed`) and left in
  place; a head absent at that read is refused with the named 409
  (`skill_head_missing`). Memory's ordinary delete runs through
  withSharedWriteTransaction, which joins a request-owned transaction when one
  exists.
