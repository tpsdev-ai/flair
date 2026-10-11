- **An owner-guarded write is refused when the stored row cannot be read.**

  The shared owner-field guard (resources/owner-field-guard.ts, applied to
  Asset, Credential, Integration, Memory, MemoryCandidate, MemoryGrant, OrgEvent,
  Relationship, Soul and WorkspaceState writes) no longer collapses a stored-row
  read failure into "no stored row". A read that throws or rejects answers
  `owner_check_unavailable` (503; 400 for a client-status read error) and the
  write does not happen; a read that resolves to no row is unchanged.

  Scope, measured on real Harper 5.3.1: on the HTTP path the stored row is loaded
  by Harper's REST layer (`Table.getResource` → `resource._loadRecord`) BEFORE the
  resource runs, and a no-argument `super.get()` returns that cached record — so a
  truly unreadable row is refused one layer up, with Harper's own 500, and the
  guard's named refusal is a fail-closed backstop for the reads Harper's load does
  not perform (in-process calls, or a resource that reads the row itself). Admin
  and internal callers bypass the guard entirely. Soul additionally resolves the
  stored row through `resolveStoredRow` first and is refused there with
  `stored_row_lookup_failed` (500) before this guard runs.
