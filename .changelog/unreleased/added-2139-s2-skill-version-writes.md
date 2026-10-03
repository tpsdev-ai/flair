- **Skill writes now append version records and keep history.** Creating, updating,
  deleting or feed-ingesting a skill appends an `InstructionVersion` row; an update
  supersedes (a fresh Memory row, the predecessor closed) instead of overwriting, and
  a stable `skillSubjectId` carries the chain across physical rows.

  Deleting a skill is now a logical delete: the retained payload is closed, not removed,
  and a tombstone version is appended. Read authority is unchanged from the read half
  (owner/non-private, against both the version and the subject's current state).

  > **Heads-up:** the administrator operations API remains an explicitly unaudited
  > exception for skill versions: a raw upsert/delete under admin auth does not append
  > a version record.
