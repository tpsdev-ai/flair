- **A write grant does not include changing a record's visibility: a grant-authorized successor write carries its predecessor's visibility.**

  For a successor written under a "write" MemoryGrant (a cross-agent supersede
  of a memory through `POST`/`PUT /Memory`, or of a skill through
  `POST`/`PUT /Memory` and `POST /FeedMemories`), the grant-authorized write
  carries the predecessor's visibility when it omits one. A write naming a
  visibility that reads differently from the predecessor's is refused with 403
  `grant_cannot_change_visibility` and writes nothing, unless an earlier
  validation refuses it first: an ephemeral write naming `shared` gets the
  ephemeral private-only rule's 400 `invalid_visibility_for_durability`, and an
  ephemeral or session skill write gets the skill-durability gate's 400
  `skill_durability`. An ordinary ephemeral successor that omits visibility on
  a shared predecessor carries `shared`, which the ephemeral rule refuses with
  the same 400. The close stages its write and then re-reads the predecessor's
  committed row; if that row's visibility no longer reads the same as the
  successor's, the write is refused with 409 `predecessor_visibility_changed`
  and writes nothing, and a retry that omits visibility carries the current
  one. A change committed after that final re-read and before the write commits
  is not seen by it. An ordinary successor and its close commit or abort
  together in the write's transaction, including a joined request or caller
  transaction: a close that cannot land refuses the whole write, with 409
  `granted_close_revoked` when the grant was revoked and 409
  `stored_row_changed` when the predecessor changed during the write. The rule
  governs the grant-authorized write: an ordinary successor is the grantee's
  own row, so the grantee may later change that row's visibility as its owner,
  and a skill successor keeps its lineage owner. Owner and admin writes are
  unchanged.
