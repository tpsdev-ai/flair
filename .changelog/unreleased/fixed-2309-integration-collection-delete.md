- **An operator's collection DELETE on Integration now removes the matched
  rows.** Integration now awaits its search, selects primary keys, and deletes
  those keys. Harper's native collection-delete loop cannot consume a
  Promise-returning search override when a resource delegates to that loop;
  Integration previously did so and returned 500. Async search overrides exist
  on Asset, Credential, InstructionVersion, Integration, Memory, MemoryCandidate,
  MemoryGrant, MemoryHostSource, MemoryUsage, Message, Relationship, and
  WorkspaceState. InstructionVersion and MemoryHostSource refuse DELETE;
  Memory has its own deletion path. A runtime principal's collection DELETE
  stays refused.
