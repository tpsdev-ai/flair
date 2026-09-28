# @tpsdev-ai/langgraph-flair

LangGraph-style store backed by [Flair](https://github.com/tpsdev-ai/flair), with Ed25519 authentication when a key resolves and administrator Basic authentication when configured without a key.

FlairStore implements LangGraph's `BaseStore` interface; it provides get, put, delete, search, batch, and namespace enumeration, with the limitations below. Other Flair-enabled harnesses can retrieve these stored JSON items when connected to the same Flair instance with access to the owning agent's records, including:

- Claude Code / Cursor / Continue.dev / Codex (via [`@tpsdev-ai/flair-mcp`](../flair-mcp))
- OpenClaw (via [`@tpsdev-ai/openclaw-flair`](../openclaw-flair))
- n8n (via [`@tpsdev-ai/n8n-nodes-flair`](../n8n-nodes-flair))
- Hermes Agent (via [`hermes-flair`](../hermes-flair))
- Pi agent (via [`@tpsdev-ai/pi-flair`](../pi-flair))

## Install

```bash
npm install @tpsdev-ai/langgraph-flair @tpsdev-ai/flair-client
# Or, if you're already using LangGraph:
npm install @tpsdev-ai/langgraph-flair
```

## Usage

```typescript
import { FlairStore } from "@tpsdev-ai/langgraph-flair";
import { StateGraph } from "@langchain/langgraph";

const store = new FlairStore({ agentId: "my-agent" });

const graph = new StateGraph(...)
  .compile({ store });

// Or with createReactAgent:
import { createReactAgent } from "@langchain/langgraph/prebuilt";
const agent = createReactAgent({ llm, tools, store });
```

## How LangGraph's namespace maps to Flair

LangGraph's `BaseStore` uses hierarchical namespaces (`["users", "profiles"]`) and string keys (`"user123"`). FlairStore maps each item to a Flair memory:

| LangGraph | Flair |
|-----------|-------|
| `namespace: ["users", "profiles"]` | `tags: ["lg-ns:users/profiles"]` |
| `key: "user123"` | id suffix: `lg:<agentId>:users/profiles:user123` |
| `value: { name: "Alice" }` | `content: '{"name":"Alice"}'` |
| `search.query: "..."` | Non-empty search queries call Flair's `/SemanticSearch` endpoint. The server selects hybrid (BM25 plus vector), vector-only, or BM25-only retrieval; embedding availability affects whether the vector leg can run. |
| `search.filter: { age: { $gte: 18 } }` | applied client-side after retrieval |

## Authentication

`FlairStore` composes a `FlairClient`. Three options:

1. **Ed25519 keypair** (preferred): pass `agentId` to the constructor; the client also reads `FLAIR_AGENT_ID` from env, but the constructor parameter is required.
2. **Explicit key file**: use `new FlairStore({ agentId, keyPath: "/path/to/key.key" })` with a file containing base64-encoded PKCS8 DER or a raw Ed25519 seed; pass a PEM string through privateKey instead.
3. **Basic auth fallback**: `new FlairStore({ agentId, adminUser, adminPassword })` for standalone deployments. It is used only when no key resolves for the request: a present key wins, and a rejected signature is not retried with Basic. The client refuses to send Basic auth over plain HTTP to a non-loopback host.

```typescript
const store = new FlairStore({
  agentId: "my-agent",
  url: "https://flair.example.com",  // or FLAIR_URL env var
  adminUser: process.env.FLAIR_ADMIN_USER,
  adminPassword: process.env.FLAIR_ADMIN_PASSWORD,
});
```

If a key for `my-agent` is found, the store signs with it and does not send the admin credentials.

## What you get

- **Persistence**: items are stored in the Flair server and can outlive the LangGraph process when the server's data is retained.
- **Federation**: configured peers can sync eligible non-private memories; new FlairStore items default to private and are excluded from federation.
- **Cross-orchestrator**: authorized Flair integrations can retrieve the JSON items stored here; FlairStore does not automatically capture or transfer LangGraph checkpoints or conversation history.
- **Identity**: every memory is scoped to an `agentId` that verifies writes with Ed25519 auth when a key is present (admin Basic credentials skip cryptographic validation). A signed non-admin agent can write only as itself; non-private memories are readable by other agents on the instance. Do not use memory contents or namespace tags to enforce tenant access.
- **Open source**: runs on your hardware. No SaaS lock-in.

## Limitations (v1)

- FlairStore exposes no IndexConfig option and ignores the per-item index argument. It sends each value as JSON content to Flair, which attempts server-side embedding using its configured backend. To store fields separately, extract them into separate items before calling put.
- `search.filter` operators (`$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`) are applied client-side after retrieval. Neither the tag-based path nor the semantic path applies a namespace pre-filter on the server; both fetch then filter on the client. For non-semantic queries, the adapter lists the agent's memories and checks namespace-tag prefixes client-side; semantic results are also filtered by namespace prefix client-side. High-fanout filters across many memories will be slower.
- Namespace-prefix matching compares whole labels, so a search for `("users",)` includes descendant namespaces and excludes unrelated labels such as `("usersX",)`. An empty prefix searches the agent's LangGraph items across namespaces, subject to filtering and pagination. The non-semantic path reads the agent's full item set with no candidate cap, so a parent-prefix search never returns a short page when more matches exist. The stored namespace encoding escapes `/` and `:` in labels and restores their original values when decoded. Earlier items under valid labels without `/` or `:` keep their ids and tags and need no migration. Items that earlier versions stored under a label containing `/` or `:` are not read back under their original namespace; delete them by id and write them again. The semantic path still checks the requested namespace prefix after retrieving candidates. An unpaired surrogate in a namespace label or key makes `put` and `delete` throw and makes `get` return null before any request. Such a label in a `search` prefix or `listNamespaces` match condition matches nothing before any request; it cannot be percent-encoded in a Memory ID path.
- `listNamespaces` is public and returns namespaces derived from the agent's newest 1,000 memories (a bounded scan), applies match conditions and maxDepth, then paginates the distinct results. Namespaces without stored items cannot be enumerated, and namespaces represented only outside that scan can be missed.

## License

Apache 2.0 — same as Flair core.
