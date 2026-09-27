# @tpsdev-ai/langgraph-flair

LangGraph `BaseStore` adapter backed by [Flair](https://github.com/tpsdev-ai/flair) — durable agent memory with crypto-pinned per-agent identity, federated peer-to-peer sync, and cross-orchestrator portability.

Drop-in for LangGraph's `InMemoryStore`. The same memories your LangGraph agent writes are then visible to every other Flair-enabled harness:

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
| `search.query: "..."` | semantic search via Flair's HNSW index |
| `search.filter: { age: { $gte: 18 } }` | applied client-side after retrieval |

## Authentication

`FlairStore` composes a `FlairClient`. Three options:

1. **Ed25519 keypair** (preferred): pass `agentId` to the constructor; the client also reads `FLAIR_AGENT_ID` from env, but the constructor parameter is required.
2. **Explicit key path**: `new FlairStore({ agentId, keyPath: "/path/to/key.pem" })`
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

- **Persistence**: memories survive process restarts and re-deploys.
- **Federation**: pair your local Flair to a hub; memories sync peer-to-peer.
- **Cross-orchestrator**: switch from LangGraph to OpenClaw to Claude Code without losing the agent's history.
- **Identity**: every memory is scoped to an `agentId` that verifies writes with Ed25519 auth when a key is present (admin Basic credentials skip cryptographic validation). A signed non-admin agent can write only as itself; non-private memories are readable by other agents on the instance. Do not use memory contents or namespace tags to enforce tenant access.
- **Open source**: runs on your hardware. No SaaS lock-in.

## Limitations (v1)

- LangGraph's `IndexConfig` (custom embedding model, per-field indexing) is ignored. Flair has its own embedding pipeline (`nomic-embed-text-v1.5`, 768-dim) and embeds the full content blob. If you need per-field embeddings, pre-extract and store as separate items.
- `search.filter` operators (`$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`) are applied client-side after retrieval. Neither the tag-based path nor the semantic path applies a namespace pre-filter on the server; both fetch then filter on the client. For non-semantic queries with a non-empty prefix, the tag lookup performs an exact match on the joined tag, while semantic results are post-filtered client-side against the requested namespace prefix. High-fanout filters across many memories will be slower.
- Namespace-prefix matching requests the full joined-path tag (`lg-ns:users/profiles`) from the non-semantic path; that exact-tag lookup applies only for a non-empty prefix—an empty prefix sends no tag filter. The semantic path post-filters against the prefix, which is the sole route to descendant matches for a non-empty prefix. A non-semantic search with an empty prefix can therefore return entries from any of the agent's namespaces, including descendants, up to its candidate limit. LangGraph's `BaseStore.search` API doesn't expose a label-only surface either, so there's no read path that would benefit; if a future LangGraph extension exposes it we'd add a derived index then.
- `listNamespaces` returns namespaces seen in your stored memories (best-effort scan via `batch()`). Empty namespaces aren't enumerable.

## License

Apache 2.0 — same as Flair core.
