- **Read-scope enforcement in `Memory.search()` and `WorkspaceState.search()` no longer depends on
  the caller's query operator.** Both resources composed their ownership condition in a way that a
  caller-supplied top-level operator could weaken, so an authenticated agent could receive records
  belonging to other agents. Ownership is now enforced as the outer `AND` around the caller's own
  query block, matching the composition `MemoryCandidate` already used.

  **Upgrading is recommended for any deployment that serves more than one agent.** Exploitation
  requires an authenticated principal — it is not reachable anonymously — but it crosses the
  per-agent read boundary, which is the boundary Flair exists to hold.

  The composition now lives in one place, `makeScopedSearch()` in `record-type-kit.ts`, rather than
  being hand-rolled per resource. It had been written three times and was correct once; a shared
  implementation is what stops the next resource from getting it wrong. Boolean-injection guard
  tests now cover every scoped resource, not just the one that happened to be correct.
