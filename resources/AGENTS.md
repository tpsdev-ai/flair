# Server resource map

Read the root [repo map](../AGENTS.md) and [design invariants](../DESIGN.md) first.
`config.yaml` loads compiled top-level resource modules; schema tables are in
[`schemas/`](../schemas/). Moving a boot module into a subdirectory can change
whether it is loaded. Check the loader configuration when extracting code.

| Change | Start here | Shared contract |
|---|---|---|
| Soul authorship | `Soul.ts`, `soul-write-policy.ts` | Operator/internal source allowlist; generic learned-content backstop; dated `adk:` bridge in `soul-adk-guard.ts`; raw writer inventory in `test/unit/soul-writer-coverage.test.ts` |
| Memory writes/lifecycle | `Memory.ts` | `memory-durability.ts`, `memory-visibility.ts`, `provenance.ts` |
| Read access | `memory-read-scope.ts` | `resolveReadScope()` supplies both query condition and row predicate |
| Authentication/ownership | `agent-auth.ts`, `auth-middleware.ts` | `record-owner-guard.ts`, `owner-field-guard.ts`, `record-types.ts` |
| Search | `SemanticSearch.ts` | `semantic-retrieval-core.ts`; lexical index in `bm25-index-service.ts` |
| Session context | `MemoryBootstrap.ts` | shared retrieval core; budget/connector checks in `test/helpers/mcp-conformance.ts` |
| MCP / embedded API | `mcp-tools.ts`, `mcp-handler.ts`, `in-process-api.ts` | compare the separately packaged stdio adapter and client too |
| Federation | `Federation.ts` | `federation-classify.ts`, `federation-crypto.ts`, `federation-peer-liveness.ts`; sender orchestration in `src/cli.ts` |

Preserve these boundaries:

- Resolve identity from the resource context. Keep authenticated HTTP and deliberate internal calls distinct.
- Compose caller filters inside the authoritative read scope; preserve the row re-check after retrieval.
- Audit each exposed mutation verb. A `put()` guard does not automatically cover `patch()` or `post()`.
- Raw table access bypasses custom Resource rules. Use it only with an explicit internal authorization contract.
- Harper `put()` replaces a row. Use the established full-row merge helpers for partial updates; they do not promise atomic counters. Search hit-tracking is the exception: `resources/hit-tracking.ts` increments `MemoryHitStat` with per-id coalescing and overlays `retrievalCount` / `lastRetrieved` on read.
- Bootstrap calls the retrieval core without search hit-tracking side effects. Keep raw similarity separate from fused ordering.

Use [`test/AGENTS.md`](../test/AGENTS.md) for validation. Resource integration tests
must exercise actual HTTP verbs and identities; a mock table alone cannot verify
Harper routing or transaction behavior.
