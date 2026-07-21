# 🎖️ Flair

[![CI](https://github.com/tpsdev-ai/flair/actions/workflows/test.yml/badge.svg)](https://github.com/tpsdev-ai/flair/actions/workflows/test.yml)
[![Docker Test](https://github.com/tpsdev-ai/flair/actions/workflows/docker-test.yml/badge.svg)](https://github.com/tpsdev-ai/flair/actions/workflows/docker-test.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

> **The identity and memory substrate for AI agents. Crypto-pinned. Federated. Self-hosted.**

Flair is the **identity + memory substrate for AI agents**. Cryptographic per-agent identity (Ed25519). Soul as a first-class primitive, separate from memory. Federation across hosts (hub/spoke). Same agent, every orchestrator — memory follows.

```
┌──────────────────────────────────────────────────────────────────┐
│  same agent, same memory, every harness                          │
│                                                                  │
│  Claude Code  ─┐                                                 │
│  Cursor       ─┤                                                 │
│  Codex CLI    ─┼─[ flair-mcp ]─┐                                 │
│  Gemini CLI   ─┤               │                                 │
│  Continue.dev ─┤               │   ┌──────────────────────┐      │
│  Goose        ─┘               ├─▶ │  Flair (self-hosted) │      │
│  LangGraph   ─[ langgraph-flair ]──│  Ed25519 / HNSW /    │      │
│  OpenClaw    ─[ openclaw-flair  ]──│  Soul + Memory       │      │
│  n8n         ─[ n8n-nodes-flair ]──└──────────┬───────────┘      │
│  Hermes      ─[ hermes-flair    ]─┘           │ federation       │
│  Pi agent    ─[ pi-flair        ]─┘           │ (hub/spoke)      │
│                                               ▼                  │
│                                    ┌──────────────────────┐      │
│                                    │  Flair (Fabric hub)  │      │
│                                    └──────────────────────┘      │
└──────────────────────────────────────────────────────────────────┘
```

11 harness surfaces today. Pick whichever you're shipping in; the memory layer doesn't care. **[See the full integrations catalog →](docs/integrations.md)**

## What it looks like

![Flair: write a memory, find it by meaning, list of supported harnesses](docs/assets/flair-demo.gif)

`flair memory add` writes a memory; `flair search` finds it by meaning, not keywords. The same memory is then visible to every harness in the catalog above.

### Same identity, every orchestrator

![Flair cross-orchestrator: one agent, one memory store, three MCP-capable CLIs](docs/assets/flair-cross-orchestrator.gif)

Same Ed25519 identity, same memory store, three different MCP-capable CLIs (Claude Code, Codex CLI, Gemini CLI). A memory written from one is immediately retrievable from the next. Your agent's identity and history aren't bound to a single orchestrator's runtime.

## How Flair compares

| | Flair | Mem0 | Honcho | Letta (MemGPT) | Built-ins (OAI/Anthropic/Google) |
|---|---|---|---|---|---|
| **Identity model** | **Ed25519 per agent (crypto-pinned)** | tenant-isolation | per-user soft tenant | runtime-bound | account-scoped |
| **Federation (peer-to-peer)** | **yes — hub/spoke validated** | no | no | no | no |
| **Cross-orchestrator** | **11+ harnesses, same memory** | several | several | runtime-bound | vendor-locked |
| **Soul / persistent character** | **first-class** | optional | persona-shaped | optional | no |

Four rows where Flair holds a cell no other system holds cleanly today. Parity rows (license, self-host, semantic search) are table-stakes for this neighborhood — Mem0, Honcho, and Letta are all open-source and self-hostable — so they're omitted to keep the moat visible.

The honest gaps:

- Mem0's **cloud sync UX** is more polished if you're OK with their hosting.
- Honcho's **persona model** is more developed if rich personality modeling is your priority.
- Letta's **runtime integration** is tighter if you're building on their agent loop.

If you need any of those specifically, use them. If you need crypto-pinned identity + federation + cross-orchestrator breadth + soul-as-a-feature — that's the gap Flair fills.

### Memory curation: vs Claude Dreams

Anthropic shipped [Claude Dreams](https://platform.claude.com/docs/en/managed-agents/dreams) (research preview, April 2026) — async pipeline that reads a memory store + session transcripts and produces a curated output store: duplicates merged, stale entries replaced, insights surfaced. Validates the category: agent memory accumulates drift and needs cleanup.

Flair ships both the on-demand curation surface (`flair rem rapid`) AND the scheduled nightly cycle, per the [FLAIR-NIGHTLY-REM spec](specs/FLAIR-NIGHTLY-REM.md) and its [in-process distillation slice](specs/FLAIR-NIGHTLY-REM-SLICE-2-DISTILLATION.md). Config recipe (Ollama zero-key default, hosted-provider egress warning, clustered-deploy rules): [`docs/rem.md`](docs/rem.md).

- **`flair rem rapid`** — reflects and distills server-side by default, staging candidates in one bounded call. `--focus {lessons_learned, patterns, decisions, errors}` mirrors Dreams' `instructions` parameter. `--prompt-only` falls back to the bring-your-own-model handoff. Outputs *candidates*, not a wholesale store swap.
- **`flair rem candidates` / `flair rem promote <id> --rationale "<why>"` / `flair rem reject <id>`** — review and promote distilled candidates with required rationale.
- **`flair rem nightly enable [--at HH:MM]`** — scheduled automation via platform-native scheduler (launchd / systemd). Pre-cycle snapshot to `~/.flair/snapshots/<agent>/<iso>.tar.gz`. Maintenance (soft-delete expired + soft-archive stale) and distillation (staged candidates) both run each cycle. Audit log to `~/.flair/logs/rem-nightly.jsonl`. `flair rem pause` / `resume` for emergency stop.
- **`flair rem restore <date> --apply`** — rewinds Harper state to a snapshot. Takes a pre-restore snapshot of current state first, so the rewind itself is reversible.
- *Next* — trust-tier filter on REM input, cross-agent restore. Until the trust-tier arc lands, the input filter stays scope-based (own agent, non-archived, non-permanent, scope window); the structural safety net is unchanged either way — candidates are staged, never auto-promoted.

The substantive difference is the **promotion contract**:

| | Claude Dreams | Flair REM (today) |
|---|---|---|
| **Output** | New memory store — accept or discard | Staged candidates — per-candidate decision |
| **Promotion gate** | None — accept the whole store | `flair rem promote <id> --rationale "<why>"` |
| **Reversibility** | Input store is never modified (real safety property) | Pre-cycle snapshot + `rem restore <date> --apply` (rewinds Harper state, takes a pre-restore snapshot too) |
| **Where it runs** | Anthropic Managed Agents (SaaS, Anthropic models only) | Self-hosted, any model |

Dreams is easier to start with — one API call, and the input-never-modified contract gives you a clean rollback by simply not accepting the output. REM is the more granular surface — per-candidate decisions with required rationale — for operators who want to merge what's right and reject what's wrong on the same nightly cycle. Both are legitimate choices; the right one depends on whether you want store-level or candidate-level review.

## Why this exists

Every agent framework gives you chat history. None of them give you *identity*.

An agent that can't remember what it learned yesterday, can't prove who it is to another agent, and loses its personality on restart isn't really an agent. It's a stateless function with a system prompt.

Flair fixes that with three primitives:

- **Identity** — Ed25519 key pairs. Agents sign every request. No passwords, no API keys, no shared secrets. Write isolation (no agent can write as another) is enforced at the server, not by client convention; reads are open within the org for non-private memories by design (see [SECURITY.md](SECURITY.md)).
- **Memory** — Persistent knowledge with semantic search (in-process [nomic-embed-text](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF), 768-dim, no API calls). Tiered durability (`permanent` / `persistent` / `standard` / `ephemeral`). Temporal validity. Decay-and-retrieval-aware composite scoring.
- **Soul** — Personality, values, procedures. The stuff that makes an agent *that agent*. Re-injected every turn via the context-engine plugin so it doesn't drift across long sessions.

Built on [Harper](https://harper.fast). Single process. No sidecars. Zero external API calls for embeddings. **[Supply-chain policy](docs/supply-chain-policy.md)** documents the bake-time + dep-pinning we run to keep this honest.

See **[DESIGN.md](DESIGN.md)** for the design invariants behind these three primitives — why they're shaped the way they are.

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

### Trust-Graded Recall
Recall can carry an opt-in **trust-evidence block** per result — provenance (verified vs claimed author), usage signal, freshness/validity, supersession — so an agent weighs *what to trust*, not just *what matched*. On top of it:

- **Confidence bands** (`matchQuality`): each result is labeled `strong` / `moderate` / `breadcrumb` from its absolute similarity — a weak-but-relevant hit is taken for what it is, not mistaken for a confident one.
- **First-class abstention** (`abstain`): when nothing clears a confidence floor, recall returns an honest "no memory covers this" verdict instead of the N weakest matches.
- **Citation-on-write** (`usedMemoryIds`) + **`record_usage`**: report which memories actually grounded an answer — a deduped, principal-bound usage signal (honest evidence, never retrieval-popularity) that strengthens future recall.

Opt-in and additive (`includeTrust` / `abstain` on the recall path) — off by default, byte-identical when unused. Reachable today via the authenticated HTTP API and the native `/mcp` tools; first-class exposure in the `flair` CLI, `@tpsdev-ai/flair-client`, and the `flair-mcp` bridge is a follow-up. Full arc in the [CHANGELOG](CHANGELOG.md) (flair#744).

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
Entity-to-entity triples with temporal bounds. Model structured knowledge — "Alice works-with Bob since 2024-01-01" — queryable alongside semantic memory.

### Real-Time Feeds
Subscribe to memory or soul changes via WebSocket/SSE. Useful for dashboards, cross-agent sync, or audit trails.

### Multi-Agent
One Flair instance serves any number of agents. Each agent has its own keys, memories, and soul. Reads are open within the org: any agent can read any other agent's non-private memory, no grant required — `private` is the one owner-only exception. See [DESIGN.md](DESIGN.md#access-model-open-within-the-org-closed-at-the-federation-edge) for the full model.

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

### Embedding benchmarks (`flair-bench`)
A standalone benchmark you can run anywhere — no Flair install, no server, just Node and a GGUF file. It ships the same 126-query recall corpus and scoring Flair's own CI gates on, so its numbers are directly comparable: benchmark candidate embedding models (`--model-file`, batchable), get a model recommendation for the host you're on backed by the numbers it just measured (`recommend`), and optionally save a redacted, shareable result (`--share`) — including a `--label` for tagging host classes when characterizing fleet hardware. See [packages/flair-bench](packages/flair-bench/README.md).

## Quick Start

### Prerequisites

**1. Node.js 22+.** On a fresh box, install a current Node — the version in some distro repos is too old.

```bash
# Linux (Debian/Ubuntu) — NodeSource:
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs

# macOS / Linux — nvm (no root, recommended):
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
# restart your shell, then:
nvm install 22

# Verify:
node --version   # → v22.x or newer
```

**2. A user-writable npm global prefix (avoid `sudo`).** Installing globally with `sudo` makes the package root-owned. Flair's in-process embeddings component downloads/symlinks a model file under the package at runtime; when Harper later runs as **you** (not root) it gets `EACCES` and **semantic search silently degrades to keyword-only**. Point npm's global prefix at your home dir instead:

```bash
mkdir -p ~/.npm-global
npm config set prefix ~/.npm-global
# add to your shell rc (~/.bashrc, ~/.zshrc) so it persists:
export PATH="$HOME/.npm-global/bin:$PATH"
```

> ⚠️ **Do not `sudo npm install -g @tpsdev-ai/flair`.** A root-owned install breaks the embeddings component (the package dir isn't writable by the user Harper runs as), and you'll get the loud `Semantic search DEGRADED` warning from `flair init` / `flair doctor`. Use the user-writable prefix above instead. `nvm` installs already give you a user-owned prefix, so no `sudo` is needed there.

### Install & Run

`flair init` is the front door. The mental model is git's: install the CLI globally, then `init`. One command does everything: installs and starts Harper, creates your agent's Ed25519 identity, verifies semantic search actually works, detects and wires your MCP clients (Claude Code / Cursor / Codex / Gemini) to the zero-install `npx -y @tpsdev-ai/flair-mcp` server, and runs a smoke test.

```bash
# Install the CLI (no sudo — see prereqs above)
npm install -g @tpsdev-ai/flair

# One command: instance + agent + semantic-search check + MCP wiring + smoke test
flair init
```

That's it. Your agent now has identity and memory, and any detected MCP client is wired up. Restart your MCP client (e.g. Claude Code) to pick up the new config, then ask the agent "what do you remember about me?"

Useful flags:

```bash
flair init --agent mybot           # name the agent (--agent-id also works)
flair init --client claude-code    # wire one specific client (claude-code, codex, gemini, cursor, all, none)
flair init --no-mcp                # instance + agent only, skip MCP wiring
flair init --skip-smoke            # skip the MCP smoke test
```

Lifecycle management:

```bash
flair status        # Check everything is working
flair stop          # Stop the Flair instance
flair restart       # Restart the Flair instance
flair uninstall     # Remove the service (keeps data)
flair uninstall --purge  # Remove everything including data and keys
```

### Upgrading

`flair status` and `flair doctor` both check your installed version against the latest published release (cached, offline-tolerant — this never blocks or fails either command) and print a nudge when you're behind:

```
⚠ flair 0.16.1 is behind — latest is 0.20.1 (4 releases behind). Upgrade: npm i -g @tpsdev-ai/flair@latest
```

To upgrade:

```bash
npm install -g @tpsdev-ai/flair@latest

# Or check what's outdated across the whole toolchain (flair, flair-mcp, the
# openclaw-flair plugin) without installing anything:
flair upgrade --check

# Then apply:
flair upgrade
```

`flair upgrade` also restarts the running instance for you with `--restart`. If you deployed Flair to a Harper Fabric cluster (rather than running it locally), use `flair upgrade --target <fabric-url>` instead — see `flair upgrade --help`.

### Advanced / manual setup

Prefer to drive each step yourself, or scripting an unattended setup? Run `flair init --no-mcp` to bootstrap the instance + agent without wiring any MCP clients, then drive each step on its own:

```bash
# Bootstrap a Flair instance without registering an agent or wiring MCP
flair init --no-mcp

# Register your first agent (generates an Ed25519 keypair, registers it)
flair agent add mybot --name "My Bot"

# Check everything is working
flair status
```

`flair init --agent mybot --no-mcp` bootstraps the instance and registers an agent in one step without touching any MCP client config. To wire clients later, re-run `flair init --agent mybot --client <name>`, or wire them manually using the snippets in **[docs/mcp-clients.md](docs/mcp-clients.md)** — all of them use the `npx -y @tpsdev-ai/flair-mcp` zero-install form.

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

The plugin auto-detects your agent identity, provides `memory_store`/`memory_recall`/`memory_get` tools, and injects relevant memories at session start. See the [plugin README](packages/openclaw-flair/README.md) for details.

### Claude Code / Gemini CLI / OpenAI Codex CLI / Cursor (MCP)

One MCP server, many CLIs. Install the MCP server for native tool integration in any MCP-capable client:

```json
// .mcp.json in your project root (Claude Code / Cursor format)
{
  "mcpServers": {
    "flair": {
      "command": "npx",
      "args": ["-y", "@tpsdev-ai/flair-mcp"],
      "env": { "FLAIR_AGENT_ID": "mybot" }
    }
  }
}
```

Add to your `CLAUDE.md`:

    At the start of every session, run mcp__flair__bootstrap before responding.

Your agent's memory **follows it across CLIs** — same Flair instance, same agent identity, switch from Claude Code to Gemini CLI to Codex CLI without losing state. The `flair-mcp` server — the bridge these CLIs connect to — exposes `memory_store`, `memory_search`, `memory_update`, `memory_get`, `memory_delete`, `relationship_store`, `bootstrap`, `soul_set`, `soul_get`, `flair_workspace_set`, and `flair_orgevent`. (Flair's in-Harper native `/mcp` surface is a separate, still-experimental tool set with `attention` + `record_usage` — see Trust-Graded Recall above.)

For per-CLI config snippets (Gemini CLI's `~/.gemini/settings.json`, Codex CLI's `~/.codex/config.toml`, etc.), see **[docs/mcp-clients.md](docs/mcp-clients.md)**. For a deeper Claude Code walk-through with `CLAUDE.md` patterns, see [docs/claude-code.md](docs/claude-code.md).

### n8n (community node)

Use Flair as the memory backend for n8n's AI Agent. Same memories readable from Claude Code and OpenClaw — that's the point.

```bash
# In n8n: Settings → Community Nodes → Install
@tpsdev-ai/n8n-nodes-flair
```

Three nodes ship: **Flair Chat Memory** (Memory port, conversation buffer), **Flair Search** (Tool port, semantic search + get-by-subject), and **Flair Write** (Tool port, store memories). Setup walkthrough, subject/sessionId patterns, and security guidance in **[docs/n8n.md](docs/n8n.md)**.

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

### Auth across surfaces

The default, secure path everywhere is **Ed25519 per-agent**: each agent holds its own key (`~/.flair/keys/<agent>.key`) and signs every request. That guarantees write isolation (no agent can write as another) and identity-verified reads — it does **not** mean cross-agent reads are refused: within one Flair instance, any verified agent can read any other agent's non-private memory by design (open-within-org read; the hard boundary is the federation edge, not intra-instance reads — see [SECURITY.md](SECURITY.md)). The CLI, the `flair-mcp` server, and the OpenClaw / pi / Hermes plugins all use this model.

One exception: the **`n8n-nodes-flair`** community node authenticates with the Harper **admin password** (Basic auth), which bypasses agent scoping entirely — including read of other agents' `visibility: private` memories and write-as-anyone, not just the org-wide non-private reads an Ed25519 identity already gets. That's acceptable only on a single-tenant, operator-controlled n8n with trusted workflow inputs; otherwise prefer the CLI/SDK Ed25519 path. Full breakdown in **[docs/auth.md](docs/auth.md#auth-across-surfaces-read-this-first)**.

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
- **Admin credentials** — `flair init` auto-generates an admin password stored at `~/.flair/admin-pass` (mode 0600). Can also be set via `HDB_ADMIN_PASSWORD`. See [SECURITY.md](SECURITY.md) for the full model.

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

### Harper Fabric

Deploy Flair on [Harper Fabric](https://www.harperdb.io/) for managed hosting with multi-region replication and failover. Federation runs against Harper Fabric hubs (e.g. `flair.your-org.harperfabric.com`) — pair your local instance to sync memories across nodes.

## Security

See [SECURITY.md](SECURITY.md) for the full security model, threat analysis, and recommendations.

**Key points:**
- Ed25519 cryptographic identity — agents sign every request
- Reads are open within the org — any agent can read any other agent's non-private memory, no grant required; `private` is the one owner-only exception (see [DESIGN.md](DESIGN.md))
- Admin password auto-generated on init, stored at `~/.flair/admin-pass` (mode 0600)
- Key rotation via `flair agent rotate-key`
- Writes are always agent-scoped — an agent can only write its own records

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
| **Memory** | data-scoping, backup-restore, agent-remove-and-grants | Private-memory exclusion, open within-org read scoping, data durability, grant lifecycle |
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
- ✅ MCP server for Claude Code / Cursor / Codex / Gemini CLI
- ✅ Lightweight client library (`@tpsdev-ai/flair-client`)
- ✅ Portable agent identity (export/import between instances)
- ✅ `flair --version`, `flair upgrade`
- ✅ First-run soul wizard (interactive personality setup)

**What's next:**
- [ ] Git-backed memory sync
- [ ] Encryption at rest (opt-in AES-256-GCM per memory)
- [ ] Harper Fabric deployment (managed multi-office)

## License

[Apache 2.0](LICENSE)
