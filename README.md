# 🎖️ Flair

**Identity, memory, and soul for AI agents.**

Agents forget everything between sessions. Flair gives them a persistent sense of self — who they are, what they know, how they think — backed by cryptographic identity and semantic search.

Built on [Harper](https://github.com/HarperFast/harper). Single process. No sidecars.

## Why

Every agent framework gives you chat history. None of them give you *identity*.

An agent that can't remember what it learned yesterday, can't prove who it is to another agent, and loses its personality on restart isn't really an agent. It's a stateless function with a system prompt.

Flair fixes that:

- **Identity** — Ed25519 key pairs. Agents sign every request. No passwords, no API keys, no shared secrets.
- **Memory** — Persistent knowledge with semantic search. Write a lesson learned today, find it six months from now by meaning, not keywords.
- **Soul** — Personality, values, procedures. The stuff that makes an agent *that agent*, not just another LLM wrapper.

## How It Works

Flair is a native [Harper v5](https://github.com/HarperFast/harper) application. Harper handles HTTP, persistence (RocksDB), and application logic in a single process.

```
Agent ──[Ed25519-signed request]──▶ Flair (Harper)
                                      ├── Auth middleware (verify signature)
                                      ├── Identity (Agent + Integration tables)
                                      ├── Memory (write → auto-embed → store)
                                      ├── Soul (permanent personality/values)
                                      └── Search (semantic + keyword, ranked)
```

**No external dependencies at runtime.** Embeddings are generated in-process using [llama.cpp](https://github.com/ggerganov/llama.cpp) via a native addon. Model runs on CPU or GPU (Metal, CUDA). No API calls, no sidecar processes, no network hops.

## Features

### Cryptographic Identity
Every agent has an Ed25519 key pair. Requests are signed with `agentId:timestamp:nonce:METHOD:/path` and verified against the agent's registered public key. 30-second replay window with nonce deduplication.

### Semantic Memory
Memories are automatically embedded on write using [nomic-embed-text](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF) (768 dimensions). Search by meaning:

```bash
# Write a memory
flair memory write "Harper v5 sandbox blocks node:module but process.dlopen works"

# Find it later by concept, not exact words
flair memory search "native addon loading in sandboxed runtimes"
# → [0.67] Harper v5 sandbox blocks node:module but process.dlopen works
```

### Tiered Durability
Not all memories are equal:

| Durability | Delete | TTL | Use Case |
|------------|--------|-----|----------|
| `permanent` | ❌ Rejected | None | Identity, values, core knowledge |
| `persistent` | ✅ Allowed | None | Daily logs, project context |
| `standard` | ✅ Allowed | None | Working memory (default) |
| `ephemeral` | ✅ Allowed | 24h | Scratch space, temp context |

### Real-Time Feeds
Subscribe to memory or soul changes via WebSocket/SSE. Useful for dashboards, cross-agent sync, or audit trails.

### Multi-Agent
One Flair instance serves any number of agents. Each agent has its own keys, memories, and soul. Agents can't read each other's data without explicit access grants.

## Quick Start

### Prerequisites
- [Node.js 24+](https://nodejs.org/) (Harper v5 requirement)
- [Bun](https://bun.sh/) (build tooling)

### Install & Run

```bash
git clone https://github.com/tpsdev-ai/flair.git
cd flair
bun install
bun run build

# Start Flair (Harper dev mode)
node node_modules/harperdb/bin/harper.js dev .

# Write your first memory
node scripts/flair-client.mjs memory write "I exist."

# Search memories
node scripts/flair-client.mjs memory search "existence"
```

### Cold Start Bootstrap

Agents can pull their full context on startup:

```bash
# Soul + recent memories + semantic search
node scripts/flair-bootstrap.mjs --days 3 --query "current project status"
```

Outputs markdown ready to inject into an agent's system prompt. Bounded context regardless of total memory size.

## Architecture

```
flair/
├── config.yaml              # Harper configuration
├── schemas/
│   ├── agent.graphql         # Agent + Integration tables
│   └── memory.graphql        # Memory + Soul tables
├── resources/
│   ├── auth-middleware.ts    # Ed25519 signature verification
│   ├── embeddings-provider.ts # In-process nomic embeddings
│   ├── Memory.ts            # Durability enforcement + auto-embed
│   ├── Soul.ts              # Permanent-by-default personality
│   ├── MemorySearch.ts      # Hybrid semantic + keyword search
│   ├── MemoryFeed.ts        # Real-time memory changes
│   └── health.ts            # Health check endpoint
└── scripts/
    ├── flair-client.mjs     # CLI client with Ed25519 auth
    ├── flair-bootstrap.mjs  # Agent cold start context loader
    ├── flair-sync.mjs       # Flat-file ↔ Flair sync
    └── setup-harper.sh      # First-run setup
```

### Key Design Decisions

- **Harper-native** — No Express, no middleware frameworks. Harper IS the runtime.
- **In-process embeddings** — `process.dlopen()` loads llama.cpp's native addon directly inside Harper's sandboxed VM. No sidecar, no HTTP calls.
- **Schema-driven** — GraphQL schemas with `@table @export` auto-generate REST CRUD. Custom resources extend behavior (durability guards, auto-embedding, search).
- **Auth header swap** — After Ed25519 verification, middleware swaps the auth header for Harper's internal Basic auth (sourced from `HDB_ADMIN_PASSWORD` env var, set at startup). No admin token file on disk — credentials live only in the process environment.
- **No filesystem admin tokens** — Admin credentials come exclusively from `HDB_ADMIN_PASSWORD` (Harper's own env var) or the deprecated `FLAIR_ADMIN_TOKEN` env var. The old `~/.tps/secrets/flair/harper-admin-token` file path is no longer read; any such file can be safely deleted.

## Development

```bash
bun install          # Install dependencies
bun run build        # Compile TypeScript → dist/
bun test             # Run unit + integration tests
```

Integration tests spin up a real Harper instance on a random port, run the test suite, and tear down. No mocks for the database layer.

## Status

Flair is in active development and daily use. We dogfood it — the agents that build Flair use Flair for their own memory and identity.

**What works:**
- ✅ Ed25519 agent identity and auth
- ✅ Memory CRUD with durability enforcement
- ✅ In-process semantic embeddings (768-dim, Metal GPU)
- ✅ Hybrid search (semantic + keyword)
- ✅ Soul (permanent personality/values)
- ✅ Real-time feeds
- ✅ Agent cold start bootstrap
- ✅ Daily memory sync

**What's next:**
- [ ] Encryption at rest (opt-in AES-256-GCM per memory)
- [ ] Cross-agent memory sharing with access control
- [ ] Pluggable embedding backends (OpenAI, Cohere, local)
- [ ] TPS integration (agent management ↔ identity service)

## License

[Apache 2.0](LICENSE)

---

*You know, the Nazis had pieces of flair that they made the Jews wear.* ☕
