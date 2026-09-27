- **Asset, Credential, Relationship and MemoryCandidate collection reads use the shared scoped-search helper.**
  Each composes the caller's owner scope with the query's own conditions the same way Memory reads do: the scope is the outermost condition, and every caller condition is kept. Anonymous denials, admin and internal reads, and by-id reads are unchanged.
