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
| `namespace: ["users", "profiles"]` | `tags: ["lg-ns:users/profiles", "lg-ns-part:users", "lg-ns-part:profiles"]` |
| `key: "user123"` | id suffix: `lg:<agentId>:users/profiles:user123` |
| `value: { name: "Alice" }` | `content: '{"name":"Alice"}'` |
| `search.query: "..."` | semantic search via Flair's HNSW index |
| `search.filter: { age: { $gte: 18 } }` | applied client-side after retrieval |

## Authentication

`FlairStore` inherits from `FlairClient`. Three options:

1. **Ed25519 keypair** (preferred): set `FLAIR_AGENT_ID` and the client auto-resolves your key.
2. **Explicit key path**: `new FlairStore({ agentId, keyPath: "/path/to/key.pem" })`
3. **Basic auth fallback**: `new FlairStore({ agentId, adminUser, adminPassword })` for standalone deployments.

```typescript
const store = new FlairStore({
  agentId: "my-agent",
  url: "https://flair.example.com",  // or FLAIR_URL env var
  adminPassword: process.env.FLAIR_ADMIN_PASS,
});
```

## What you get

- **Persistence**: memories survive process restarts and re-deploys.
- **Federation**: pair your local Flair to a hub; memories sync peer-to-peer.
- **Cross-orchestrator**: switch from LangGraph to OpenClaw to Claude Code without losing the agent's history.
- **Identity**: every memory is tied to a crypto-pinned `agentId`. No tenant-isolation slop.
- **Open source**: runs on your hardware. No SaaS lock-in.

## Limitations (v1)

- LangGraph's `IndexConfig` (custom embedding model, per-field indexing) is ignored. Flair has its own embedding pipeline (`nomic-embed-text-v1.5`, 768-dim) and embeds the full content blob. If you need per-field embeddings, pre-extract and store as separate items.
- `search.filter` operators (`$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`) are applied client-side after retrieving the namespace prefix. Tag-based pre-filtering (the namespace) keeps this bounded; high-fanout filters across many memories will be slower.
- `listNamespaces` returns namespaces seen in your stored memories (best-effort scan). Empty namespaces aren't enumerable.

## License

Apache 2.0 — same as Flair core.
