- **InstructionVersion reads now authorize skill subjects under Memory's owner/non-private rule.**
  A skill version is readable only when the reader may read both the version's stored
  visibility and the subject's current visibility — the head's live Memory row, or its
  tombstone after a logical delete. Missing or inconsistent authority metadata denies,
  unknown subject types deny, and admin/internal keep Memory's unfiltered exception.
