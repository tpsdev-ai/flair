# 🎖️ Flair

[![CI](https://github.com/tpsdev-ai/flair/actions/workflows/test.yml/badge.svg)](https://github.com/tpsdev-ai/flair/actions/workflows/test.yml)
[![Docker Test](https://github.com/tpsdev-ai/flair/actions/workflows/docker-test.yml/badge.svg)](https://github.com/tpsdev-ai/flair/actions/workflows/docker-test.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

**Identity, memory, and soul for AI agents. Runs standalone or as part of a [TPS](https://tps.dev) office.**

Agents forget everything between sessions. Flair gives them a persistent sense of self — who they are, what they know, how they think — backed by cryptographic identity and semantic search.

Built on [Harper](https://harper.fast). Single process. No sidecars. Zero external API calls for embeddings.

## Why

Every agent framework gives you chat history. None of them give you *identity*.

An agent that can't remember what it learned yesterday, can't prove who it is to another agent, and loses its personality on restart isn't really an agent. It's a stateless function with a system prompt.

Flair fixes that:

- **Identity** — Ed25519 key pairs. Agents sign every request. No passwords, no API keys, no shared secrets.
- **Memory** — Persistent knowledge with semantic search. Write a lesson learned today, find it six months from now by meaning, not keywords.
- **Soul** — Personality, values, procedures. The stuff that makes an agent *that agent*, not just another LLM wrapper.

## How It Works

Flair is a native [Harper v5](https://harper.fast) application. Harper handles HTTP, persistence (RocksDB), and application logic in a single process.

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

### Temporal Validity
Memories can be time-bounded with `validFrom` and `validTo` fields. Expired memories are excluded from search and bootstrap automatically — no manual cleanup.

### Relationship Graph
Entity-to-entity triples with temporal bounds. Model structured knowledge — "Flint works-with Anvil since 2024-01-01" — queryable alongside semantic memory.

### Real-Time Feeds
Subscribe to memory or soul changes via WebSocket/SSE. Useful for dashboards, cross-agent sync, or audit trails.

### Multi-Agent
One Flair instance serves any number of agents. Each agent has its own keys, memories, and soul. Agents can't read each other's data without explicit access grants.

### OAuth 2.1 Authorization Server
Built-in OAuth 2.1 server with PKCE, dynamic client registration, and a standards-compliant token endpoint. Agents and services can delegate auth to Flair without a separate IdP.

### XAA (Enterprise-Managed Authorization)
IdP integration for Google Workspace, Azure AD, and Okta. Bind agent identities to enterprise accounts — access follows your org's user lifecycle.

### Web Admin
Server-rendered admin UI for managing principals, connectors, IdPs, and instance configuration. No separate dashboard service.

### Federation
Hub-and-spoke sync between Flair instances using signed requests and pairing tokens. Originator enforcement prevents replay across federated nodes. Share memories across offices without giving any node raw access.

### Predictive Bootstrap
Context-signal-aware preloading. Bootstrap reads active project context, recent activity, and agent role to select the most relevant memories — not just the most recent ones.

### Auto Entity Detection
Passive extraction of entities from memory content on write. Entities are indexed automatically — no tagging required. Feeds the relationship graph without agent intervention.

### Memory Bridges
Pluggable import/export to foreign memory systems. Every agent-memory format (agentic-stack, Mem0, Letta, Anthropic memory, the next viral one) shouldn't need its own Flair PR. Bridges give you one contract with two shapes — a YAML descriptor for file-format targets or a code plugin for API targets — and a scaffold/test loop that lets an agent ship a working adapter in one pass. See [docs/bridges.md](docs/bridges.md).

## Quick Start

### Prerequisites
- [Node.js 22+](https://nodejs.org/)

### Install & Run

```bash
# Install
npm install -g @tpsdev-ai/flair

# Bootstrap a Flair instance (installs Harper, creates database, starts service)
flair init

# Register your first agent
flair agent add mybot --name "My Bot" --role assistant

# Check everything is working
flair status

# Lifecycle management
flair stop          # Stop the Flair instance
flair restart       # Restart the Flair instance
flair uninstall     # Remove the service (keeps data)
flair uninstall --purge  # Remove everything including data and keys
```

That's it. Your agent now has identity and memory.

## Integration

Flair works with any agent runtime. Pick the path that fits yours.

### Standalone (Flair CLI)

Use the `flair` CLI directly from any agent that can run shell commands.

```bash
# Write a memory
flair memory add --agent mybot --content "learned something important"

# Search by meaning
flair memory search --agent mybot --q "that important thing"

# Set personality
flair soul set --agent mybot --key role --value "Security reviewer"

# Cold-start bootstrap (soul + recent memories)
flair bootstrap --agent mybot --max-tokens 4000

# Backup / restore
flair backup --admin-pass "$FLAIR_ADMIN_PASS"
flair restore ./backup.json --admin-pass "$FLAIR_ADMIN_PASS"
```

### OpenClaw

One command. Zero config.

```bash
openclaw plugins install @tpsdev-ai/openclaw-flair
```

The plugin auto-detects your agent identity, provides `memory_store`/`memory_recall`/`memory_get` tools, and injects relevant memories at session start. See the [plugin README](plugins/openclaw-flair/README.md) for details.

### Claude Code / Codex / Cursor (MCP)

Install the MCP server for native tool integration:

```json
// .mcp.json in your project root
{
  "mcpServers": {
    "flair": {
      "command": "npx",
      "args": ["@tpsdev-ai/flair-mcp"],
      "env": { "FLAIR_AGENT_ID": "mybot" }
    }
  }
}
```

Add to your `CLAUDE.md`:

    At the start of every session, run mcp__flair__bootstrap before responding.

Claude Code gets native tools: `memory_store`, `memory_search`, `bootstrap`, `soul_set`, and more. See the [MCP README](packages/flair-mcp/README.md) and [Claude Code guide](docs/claude-code.md).

### JavaScript / TypeScript (Client Library)

For custom integrations, use the lightweight client — no Harper, no embeddings, just HTTP + auth:

```bash
npm install @tpsdev-ai/flair-client
```

```typescript
import { FlairClient } from '@tpsdev-ai/flair-client'

const flair = new FlairClient({
  url: 'http://localhost:19926',  // or remote: https://flair.example.com
  agentId: 'mybot',
  // key auto-resolved from ~/.flair/keys/mybot.key
})

// Write a memory
await flair.memory.write('Harper v5 sandbox blocks bare imports')

// Search by meaning
const results = await flair.memory.search('native module loading')

// Cold-start bootstrap
const ctx = await flair.bootstrap({ maxTokens: 4000 })

// Set personality
await flair.soul.set('role', 'Security reviewer')
```

See the [client README](packages/flair-client/README.md) for the full API.

### HTTP API (Any Language)

Flair is a pure HTTP API. Use it from Python, Go, Rust, shell scripts — anything that can make HTTP requests and sign with Ed25519.

```bash
# Search memories
curl -H "Authorization: TPS-Ed25519 mybot:$TS:$NONCE:$SIG" \
  -X POST http://localhost:19926/SemanticSearch \
  -d '{"agentId": "mybot", "q": "deployment procedure", "limit": 5}'

# Write a memory
curl -H "Authorization: TPS-Ed25519 mybot:$TS:$NONCE:$SIG" \
  -X PUT http://localhost:19926/Memory/mybot-123 \
  -d '{"id": "mybot-123", "agentId": "mybot", "content": "...", "durability": "standard"}'

# Bootstrap (soul + recent memories)
curl -H "Authorization: TPS-Ed25519 mybot:$TS:$NONCE:$SIG" \
  -X POST http://localhost:19926/BootstrapMemories \
  -d '{"agentId": "mybot", "maxTokens": 4000}'
```

Auth is Ed25519 — sign `agentId:timestamp:nonce:METHOD:/path` with your private key. See [SECURITY.md](SECURITY.md) for the full protocol.

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
│   ├── SemanticSearch.ts     # Hybrid semantic + keyword search
│   ├── MemoryBootstrap.ts    # Cold start context assembly
│   └── MemoryFeed.ts         # Real-time memory changes
├── plugins/
│   └── openclaw-flair/        # @tpsdev-ai/openclaw-flair plugin
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

#### Custom Ports
If the default port (`19926`) is already in use, initialize with a custom port:
```bash
flair init --port 8000
```
Flair will automatically remember this port for future CLI commands by saving it to `~/.flair/config.yaml`.

### Remote Server

Run Flair on a VPS or cloud instance. Agents connect over HTTPS:

```bash
# On the server
flair init --port 19926
# Agents connect with:
FLAIR_URL=https://your-server:19926 flair agent add mybot
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

### Test Coverage

**203+ unit tests** across 19 test files, covering 7 CI checks on every commit.

| Category | Tests | What's covered |
|----------|-------|----------------|
| **Auth & Identity** | auth-middleware, auth-scoping, key-paths-and-rotation | Ed25519 signature verification, agent isolation, key rotation |
| **Memory** | data-scoping, backup-restore, agent-remove-and-grants | Cross-agent access denied, data durability, grant lifecycle |
| **Content Safety** | content-safety | Prompt injection detection, identity hijacking, format injection, exfiltration patterns |
| **Search** | temporal-scoring, embeddings | Temporal decay, relevance scoring, embedding generation |
| **Rate Limiting** | rate-limiter | Per-agent rate limiting, bucket isolation |
| **Integration** | smoke, durability-guard | End-to-end write/search/bootstrap, durability tier enforcement |
| **CLI** | cli-v2, cli-api, first-run-soul | Full CLI command coverage, API layer, soul onboarding |

CI pipeline: unit tests, integration tests, type check, dependency audit, Semgrep SAST, CodeQL SAST, Docker from-scratch validation.

## Status

> **Note:** Flair uses [Harper v5](https://harper.fast), currently in beta. We run it in production daily and track upstream closely. Pin your Harper version.

Flair is in active development and daily use. We dogfood it — the agents that build Flair use Flair for their own memory and identity.

**What works:**
- ✅ Ed25519 agent identity and auth
- ✅ CLI: init, agent add/remove/rotate-key, status, backup/restore, export/import, grant/revoke
- ✅ Memory CRUD with durability enforcement and near-duplicate detection
- ✅ In-process semantic embeddings (768-dim nomic-embed-text via harper-fabric-embeddings)
- ✅ Hybrid search (semantic + keyword + temporal intent detection)
- ✅ Soul (permanent personality/values)
- ✅ Real-time feeds (WebSocket/SSE)
- ✅ Agent-scoped data isolation
- ✅ Cold start bootstrap with adaptive time window
- ✅ Predictive bootstrap (context-signal-aware preloading)
- ✅ Temporal validity (`validFrom`/`validTo` on memories)
- ✅ Relationship graph (entity-to-entity triples with temporal bounds)
- ✅ Auto entity detection (passive extraction from memory content)
- ✅ OAuth 2.1 authorization server (PKCE, dynamic client registration, token endpoint)
- ✅ XAA enterprise authorization (Google Workspace, Azure AD, Okta)
- ✅ Web admin UI (principals, connectors, IdPs, instance config)
- ✅ Federation (hub-and-spoke sync with signed requests and pairing tokens)
- ✅ OpenClaw memory plugin
- ✅ MCP server for Claude Code / Cursor / Windsurf
- ✅ Lightweight client library (`@tpsdev-ai/flair-client`)
- ✅ Portable agent identity (export/import between instances)
- ✅ `flair --version`, `flair upgrade`

**What's next:**
- [ ] First-run soul wizard (interactive personality setup)
- [ ] Git-backed memory sync
- [ ] Encryption at rest (opt-in AES-256-GCM per memory)
- [ ] Harper Fabric deployment (managed multi-office)

## License

[Apache 2.0](LICENSE)
