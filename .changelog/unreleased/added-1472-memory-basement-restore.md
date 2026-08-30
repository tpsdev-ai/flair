- **User-facing memory basement/restore action.** New `memory_basement(id)` and
  `memory_restore(id)` MCP tools (plus `flair memory basement <id>` /
  `flair memory restore <id>` CLI verbs) set and clear the `archived` flag on a
  memory. `basement` sends a memory to the basement (removed from bootstrap and
  default search, still retrievable via `memory_get` and
  `memory_search(includeArchived: true)`); `restore` un-basements it. Both are
  deliberate and **global** — restore un-retires a memory for *every* session,
  not a session-local view — and both are scoped to the caller's own memories.
  `memory search` also gains `--include-archived` to opt back into basemented
  results under the same read-scope gate as a normal search.
