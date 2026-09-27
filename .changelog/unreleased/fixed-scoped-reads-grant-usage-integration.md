- **Integration, MemoryUsage and MemoryGrant reads use the shared read-scope helpers.**
  Their collection reads apply the read scope as the outermost condition of the query, and their by-id reads go through the shared by-id gate, the same helpers Memory, Relationship and WorkspaceState use. A caller's query conditions can only narrow the rows an agent may read.
