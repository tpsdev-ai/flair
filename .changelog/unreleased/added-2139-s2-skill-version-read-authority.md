- **InstructionVersion reads now authorize skill subjects under Memory's owner/non-private rule.**
  A skill version is readable only when the reader may read both the version's stored
  visibility and the subject's current visibility — the head's live Memory row, or its
  tombstone after a logical delete. Ordinary readers require matching subjects, a live
  skill row owned by the head's owner, or a delete head with null memoryId; authority
  references require nonempty owners and private/shared visibility. Unknown subject
  types deny; admin/internal keep unfiltered skill reads.
