- **A write grant does not include changing a record's visibility; visibility is set by the owner or an admin.**

  A successor written under a "write" MemoryGrant (a cross-agent supersede of a
  memory through `POST`/`PUT /Memory`, or of a skill through `POST`/`PUT /Memory`
  and `POST /FeedMemories`) carries the predecessor's visibility when the write
  omits one. A grantee write naming a visibility that reads differently from the
  predecessor's is refused with 403 `grant_cannot_change_visibility` and writes
  nothing. An ephemeral successor of a shared record is refused by the
  ephemeral private-only rule. Owner and admin writes are unchanged.
