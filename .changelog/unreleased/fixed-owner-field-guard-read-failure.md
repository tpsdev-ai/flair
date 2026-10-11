- **An owner-guarded write is refused when the stored row cannot be read.**

  A stored-row read that throws or rejects answers `owner_check_unavailable`
  (503, or 400 for a client-status read error) and the write does not happen; a
  read that resolves to no row is unchanged. The shared guard that enforces
  owner-field immutability on Asset, Credential, Integration, Memory,
  MemoryCandidate, MemoryGrant, OrgEvent, Relationship, Soul and WorkspaceState
  writes makes that distinction instead of treating a failed read as an absent
  row.
