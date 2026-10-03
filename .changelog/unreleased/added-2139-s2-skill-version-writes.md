- **Skill writes now append version records and keep history.**

  A skill delete is now a logical delete: the retained payload is closed, not
  removed, and a tombstone version is appended. Read authority is unchanged from
  the read half (owner/non-private, against both the version and the subject's
  current state).

  > **Heads-up:** the operator's reserved `using-flair` seed skill keeps its
  > fixed id and is versioned in place; an operator `DELETE` of that one
  > reserved row is still a hard delete and appends no tombstone. The
  > administrator operations API remains an explicitly unaudited exception for
  > all skill versions.
