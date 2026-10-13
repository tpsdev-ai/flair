- **A successor written under a write grant has its predecessor's visibility; a write grant does not include changing a record's visibility.**

  For a successor written under a "write" MemoryGrant (a cross-agent supersede
  of a memory through `POST`/`PUT /Memory`, or of a skill through
  `POST`/`PUT /Memory` and `POST /FeedMemories`), the grant-authorized write
  carries the predecessor's visibility when it omits one, and a write naming a
  visibility that reads differently from the predecessor's is refused with 403
  `grant_cannot_change_visibility` and writes nothing. The successor is written
  only with the visibility the predecessor has on committed state when the
  close commits: if that visibility changed during the write, the write is
  refused with 409 `predecessor_visibility_changed` and writes nothing, and a
  retry carries the current visibility. An ephemeral successor of a shared
  record is refused by the ephemeral private-only rule. The rule governs the
  grant-authorized write: an ordinary successor is the grantee's own row, so
  the grantee may later change that row's visibility as its owner, and a skill
  successor keeps its lineage owner. Owner and admin writes are unchanged.
