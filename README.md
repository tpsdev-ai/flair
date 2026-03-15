# 🎖️ Flair

[![Tests](https://github.com/tpsdev-ai/flair/actions/workflows/test.yml/badge.svg)](https://github.com/tpsdev-ai/flair/actions/workflows/test.yml)
[![CodeQL](https://github.com/tpsdev-ai/flair/actions/workflows/codeql.yml/badge.svg)](https://github.com/tpsdev-ai/flair/actions/workflows/codeql.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

**Identity, memory, and soul for AI agents.**

Agents forget everything between sessions. Flair gives them a persistent sense of self — who they are, what they know, how they think — backed by cryptographic identity and semantic search.

Built on [Harper](https://github.com/HarperFast/harper). Single process. No sidecars. Zero external API calls for embeddings.

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

**No external dependencies at runtime.** Embeddings are generated in-process using [nomic-embed-text](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF) via a Harper plugin. Model runs on CPU or GPU (Metal, CUDA). No API calls, no sidecar processes, no network hops.

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
- [Node.js 20+](https://nodejs.org/) (24+ recommended)

### Install & Run

```bash
# Install
npm install -g @tps/flair

# Bootstrap a Flair instance (installs Harper, creates database, starts service)
flair init

# Register your first agent
flair agent add mybot --name "My Bot" --role assistant

# Check everything is working
flair status
```

That's it. Your agent now has identity and memory.

### Use with OpenClaw

```bash
npm install @tps/openclaw-flair
```

Add to your `openclaw.json`:
```json
{
  "memory": {
    "provider": "@tps/openclaw-flair"
  }
}
```

Your agent will automatically remember things between sessions and recall them by meaning.

### Use the CLI directly

```bash
# Write a memory
flair memory add --agent mybot --content "Harper v5 sandbox blocks bare imports"

# Search by meaning, not keywords
flair memory search --agent mybot --q "native module loading issues"

# Set personality
flair soul set --agent mybot --key role --value "Security reviewer, meticulous and skeptical"

# Back up everything
flair backup --admin-pass "$FLAIR_ADMIN_PASS"

# Restore from backup
flair restore ./flair-backup-2026-03-15.json --admin-pass "$FLAIR_ADMIN_PASS"
```

### Cold Start Bootstrap

Agents can pull their full context on startup via the `BootstrapMemories` endpoint:

```bash
curl -H "Authorization: TPS-Ed25519 ..." \
  -X POST http://localhost:9926/BootstrapMemories \
  -d '{"agentId": "mybot", "maxTokens": 4000}'
```

Returns soul + recent memories + relevant context as a formatted block. Bounded context regardless of total memory size.

## Architecture

```
flair/
├── src/cli.ts                # CLI: init, agent, status, backup, grant
├── config.yaml               # Harper app configuration
├── schemas/
│   ├── agent.graphql          # Agent + Integration + MemoryGrant tables
│   └── memory.graphql         # Memory + Soul tables
├── resources/
│   ├── auth-middleware.ts     # Ed25519 verification + agent scoping
│   ├── embeddings-provider.ts # In-process nomic embeddings
│   ├── Memory.ts             # Durability enforcement + auto-embed
│   ├── Soul.ts               # Permanent-by-default personality
│   ├── MemorySearch.ts       # Hybrid semantic + keyword search
│   ├── MemoryBootstrap.ts    # Cold start context assembly
│   └── MemoryFeed.ts         # Real-time memory changes
├── plugins/
│   └── openclaw-memory/       # @tps/openclaw-flair plugin
└── SECURITY.md                # Threat model + auth documentation
```

### Key Design Decisions

- **Harper-native** — No Express, no middleware frameworks. Harper IS the runtime.
- **In-process embeddings** — Native [nomic-embed-text](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF) (768 dimensions) via [llama.cpp](https://github.com/ggerganov/llama.cpp). Runs on CPU or GPU (Metal, CUDA). No API calls, no OpenAI key needed.
- **Schema-driven** — GraphQL schemas with `@table @export` auto-generate REST CRUD. Custom resources extend behavior (durability guards, auto-embedding, search).
- **Zero admin tokens on disk** — Admin credentials come from the `HDB_ADMIN_PASSWORD` environment variable only. Never stored on the filesystem.

## Deployment

### Local (default)

```bash
flair init
```

Your data stays on your machine. Best for personal agents, dev teams, and privacy-first setups. Flair runs as a single Harper process — no Docker, no cloud, no external services.

### Remote Server

Run Flair on a VPS or cloud instance. Agents connect over HTTPS:

```bash
# On the server
flair init --port 9926
# Agents connect with:
FLAIR_URL=https://your-server:9926 flair agent add mybot
```

Good for teams with multiple machines or always-on agents.

### Harper Fabric (coming soon)

Managed multi-region deployment via [Harper Fabric](https://www.harperdb.io/). Data replication, automatic failover, web dashboard. Enterprise scale without ops overhead.

## Security

See [SECURITY.md](SECURITY.md) for the full security model, threat analysis, and recommendations.

**Key points:**
- Ed25519 cryptographic identity — agents sign every request
- Collection-level data isolation — agents can't read each other's memories
- Admin credentials never stored on disk — environment variables only
- Key rotation via `flair agent rotate-key`
- Cross-agent access requires explicit grants

## Development

```bash
bun install          # Install dependencies
bun run build        # Compile TypeScript → dist/
bun test             # Run unit + integration tests
```

Integration tests spin up a real Harper instance on a random port, run the test suite, and tear down. No mocks for the database layer.

## Status

> **Note:** Flair uses [Harper v5](https://github.com/HarperFast/harper), currently in alpha. We run it in production daily and track upstream closely. Pin your Harper version.

Flair is in active development and daily use. We dogfood it — the agents that build Flair use Flair for their own memory and identity. 7 agents, 150+ memories, running continuously since March 2026.

**What works:**
- ✅ Ed25519 agent identity and auth
- ✅ CLI: init, agent add/remove/rotate-key, status, backup/restore, grant/revoke
- ✅ Memory CRUD with durability enforcement
- ✅ In-process semantic embeddings (768-dim nomic-embed-text, Metal GPU)
- ✅ Hybrid search (semantic + keyword)
- ✅ Soul (permanent personality/values)
- ✅ Real-time feeds (WebSocket/SSE)
- ✅ Agent-scoped data isolation
- ✅ Cold start bootstrap
- ✅ OpenClaw memory plugin

**What's next:**
- [ ] Encryption at rest (opt-in AES-256-GCM per memory)
- [ ] Pluggable embedding backends (OpenAI, Cohere, local)
- [ ] Harper Fabric deployment (managed multi-office)
- [ ] Scheduled automatic backups

## License

[Apache 2.0](LICENSE)

---

*[Looks like someone has a case of the Mondays.](https://www.youtube.com/watch?v=2AB9zPfXqQQ)* ☕
