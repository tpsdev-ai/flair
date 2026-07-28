# 🎖️ Flair

[![CI](https://github.com/tpsdev-ai/flair/actions/workflows/test.yml/badge.svg)](https://github.com/tpsdev-ai/flair/actions/workflows/test.yml)
[![Docker Test](https://github.com/tpsdev-ai/flair/actions/workflows/docker-test.yml/badge.svg)](https://github.com/tpsdev-ai/flair/actions/workflows/docker-test.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

> **The identity and memory substrate for AI agents. Crypto-pinned. Federated. Self-hosted.**

Every agent framework gives you chat history. None give you *identity*. Flair gives an agent three things that survive a restart and follow it between orchestrators:

- **Identity** — an Ed25519 keypair. The agent signs every request. No shared secrets.
- **Memory** — persistent knowledge with semantic search, embedded in-process. No API calls.
- **Soul** — the personality, values and procedures that make it *that* agent.

Self-hosted on [Harper](https://harper.fast) as a single process. No sidecars, no vector database, no embedding API.

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

11 harness surfaces today. Pick whichever you're shipping in; the memory layer doesn't care. **[Full integrations catalog →](docs/integrations.md)**

## Quick start

Needs **Node.js 22+** and a **user-writable npm global prefix**.

> ⚠️ **Never `sudo npm install -g @tpsdev-ai/flair`.** A root-owned install can't write the embedding model into its own package directory, so semantic search silently degrades to keyword-only. `flair init` and `flair doctor` will warn you loudly. Use `nvm`, or point npm at your home directory: `npm config set prefix ~/.npm-global` and add `~/.npm-global/bin` to `PATH`.

```bash
# 1. Install the CLI (no sudo)
npm install -g @tpsdev-ai/flair

# 2. Bootstrap the instance and register an agent
flair init --agent mybot

# 3. Write a memory
flair memory add --agent mybot "Harper v5 sandbox blocks node:module but process.dlopen works"

# 4. Find it back by meaning, not by keyword
flair search --agent mybot "native addon loading in sandboxed runtimes"
```

Step 4 finds the memory you never keyword-matched:

```
  Harper v5 sandbox blocks node:module but process.dlopen works
  ( 2026-07-28 · standard · 100% )
```

That trailing figure is a rank score, normalized so the top hit is always near 100% — ordering, not confidence.

`flair init` installs and starts Harper, creates the agent's Ed25519 keypair, verifies semantic search actually works, wires every MCP client it detects (Claude Code, Cursor, Codex CLI, Gemini CLI) to `npx -y @tpsdev-ai/flair-mcp`, and runs a smoke test. Restart your MCP client afterwards, then ask the agent *"what do you remember about me?"*

> **Pass `--agent`.** A bare `flair init` bootstraps the instance and stops there — no agent, no keypair, no MCP wiring.

Full walkthrough with expected output at every step: **[docs/quickstart.md](docs/quickstart.md)**.

### Useful flags

```bash
flair init --client claude-code    # wire one client: claude-code, codex, gemini, cursor, all, none
flair init --no-mcp                # instance + agent only, skip MCP wiring
flair init --skip-soul             # skip the interactive personality wizard
flair init --port 8000             # non-default port, remembered in ~/.flair/config.yaml
```

### Lifecycle

```bash
flair status              # instance health, memory stats, agents
flair doctor              # diagnose common problems and suggest fixes
flair stop                # stop the instance
flair restart             # restart it
flair uninstall           # remove the service, keep data and keys
flair uninstall --purge   # remove everything, including data and keys
```

### Upgrading

`flair status` and `flair doctor` compare your installed version against the latest published release and print a nudge when you're behind:

```
⚠ flair 0.16.1 is behind — latest is 0.20.1 (4 releases behind). Upgrade: npm i -g @tpsdev-ai/flair@latest
```

```bash
flair upgrade --check   # show the plan across flair, flair-mcp and the openclaw-flair plugin
flair upgrade           # apply it; the instance restarts automatically
```

Deployed to a Harper Fabric cluster instead of running locally? Use `flair upgrade --target <fabric-url>`.

## What it looks like

![Flair: write a memory, find it by meaning, list of supported harnesses](docs/assets/flair-demo.gif)

Write a memory, then find it by meaning. The same memory is visible to every harness in the catalog.

![Flair cross-orchestrator: one agent, one memory store, three MCP-capable CLIs](docs/assets/flair-cross-orchestrator.gif)

One Ed25519 identity, one memory store, three MCP-capable CLIs. A memory written from Claude Code is retrievable from Codex CLI and Gemini CLI a moment later. Identity and history aren't bound to one orchestrator's runtime.

## How it works

Flair is a native [Harper v5](https://harper.fast) application. Harper handles HTTP, persistence (RocksDB), and application logic in one process.

```
Agent ──[Ed25519-signed request]──▶ Flair (Harper)
                                      ├── Auth middleware (verify signature)
                                      ├── Identity (Agent + Integration tables)
                                      ├── Memory (write → auto-embed → store)
                                      ├── Soul (permanent personality/values)
                                      └── Search (semantic + keyword, ranked)
```

Embeddings are generated in-process by [nomic-embed-text](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF) (768-dim) via a Harper plugin, on CPU or GPU (Metal, CUDA). No API calls, no sidecar, no network hop. **[Supply-chain policy](docs/supply-chain-policy.md)** covers the bake-time and dependency pinning that keep it that way.

Requests are signed as `agentId:timestamp:nonce:METHOD:/path` and verified against the agent's registered public key, with a 30-second replay window and nonce deduplication.

See **[DESIGN.md](DESIGN.md)** for the invariants behind the three primitives — why they're shaped the way they are.

## Features

| Feature | What it does |
|---|---|
| **Semantic memory** | Auto-embedded on write. Search by meaning, not keywords. |
| **Tiered durability** | `permanent` (delete rejected) / `persistent` / `standard` (default) / `ephemeral` (24h TTL). |
| **Temporal validity** | `validFrom` / `validTo` bounds. Expired memories drop out of search and bootstrap automatically. |
| **Trust-graded recall** | Opt-in per-result evidence: provenance, usage signal, freshness, supersession. Confidence bands (`strong`/`moderate`/`breadcrumb`) and first-class **abstention** when nothing clears the floor. |
| **Relationship graph** | Entity-to-entity triples with temporal bounds, queryable alongside semantic memory. |
| **Auto entity detection** | Entities extracted from memory content on write. No tagging required. |
| **Predictive bootstrap** | Cold-start context selected from active project, recent activity and agent role — not just recency. |
| **Multi-agent** | One instance, any number of agents, each with its own keys, memories and soul. |
| **Federation** | Hub-and-spoke sync between instances using signed requests and pairing tokens. Originator enforcement blocks cross-node replay. [docs/federation.md](docs/federation.md) |
| **Memory hygiene (REM)** | On-demand (`flair rem rapid`) and scheduled nightly distillation. Candidates are staged and promoted one at a time with a required rationale — never auto-applied. [docs/rem.md](docs/rem.md) |
| **Memory bridges** | Import/export to foreign memory systems via a YAML descriptor or a code plugin. [docs/bridges.md](docs/bridges.md) |
| **Real-time feeds** | Subscribe to memory or soul changes over WebSocket/SSE. |
| **OAuth 2.1 server** | PKCE, dynamic client registration, standards-compliant token endpoint. Delegate auth to Flair without a separate IdP. [docs/auth.md](docs/auth.md) |
| **XAA** | Bind agent identities to Google Workspace, Azure AD or Okta accounts. |
| **Web admin** | Server-rendered UI for principals, connectors, IdPs and instance config. No separate dashboard service. |
| **Benchmarks** | [`flair-bench`](packages/flair-bench/README.md) scores candidate embedding models against the same recall corpus Flair's CI gates on. Runs standalone — no Flair install, no server. |

Trust-graded recall reaches the authenticated HTTP API and the native `/mcp` tools today; CLI, `@tpsdev-ai/flair-client` and `flair-mcp` exposure is a follow-up. REM needs a configured generative backend (Ollama, OpenAI, Anthropic, …) — without one, `flair rem rapid` fails with `Reflection error: No generative backend configured`.

## How Flair compares

| | Flair | Mem0 | Honcho | Letta (MemGPT) | Built-ins (OAI/Anthropic/Google) |
|---|---|---|---|---|---|
| **Identity model** | **Ed25519 per agent (crypto-pinned)** | tenant-isolation | per-user soft tenant | runtime-bound | account-scoped |
| **Federation (peer-to-peer)** | **yes — hub/spoke validated** | no | no | no | no |
| **Cross-orchestrator** | **11+ harnesses, same memory** | several | several | runtime-bound | vendor-locked |
| **Soul / persistent character** | **first-class** | optional | persona-shaped | optional | no |

Parity rows are omitted: Mem0, Honcho and Letta are all open-source, self-hostable, and do semantic search. Those are table stakes here.

The honest gaps — if you need one of these specifically, use that tool:

- Mem0's **cloud sync UX** is more polished, if you're happy with their hosting.
- Honcho's **persona model** is more developed, if rich personality modeling is the priority.
- Letta's **runtime integration** is tighter, if you're building on their agent loop.

## Integration

Flair works with any agent runtime. Pick the path that fits yours — **[full catalog](docs/integrations.md)**.

### Claude Code / Cursor / Codex CLI / Gemini CLI (MCP)

`flair init` wires these automatically. To do it by hand:

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

Then add to your `CLAUDE.md`:

    At the start of every session, run mcp__flair__bootstrap before responding.

The `flair-mcp` server exposes `memory_store`, `memory_search`, `memory_update`, `memory_get`, `memory_delete`, `relationship_store`, `bootstrap`, `soul_set`, `soul_get`, `flair_workspace_set` and `flair_orgevent`. Memory follows the agent across CLIs — same instance, same identity, switch harness without losing state.

Per-CLI config snippets (Gemini CLI's `~/.gemini/settings.json`, Codex CLI's `~/.codex/config.toml`) are in **[docs/mcp-clients.md](docs/mcp-clients.md)**; a deeper Claude Code walk-through is in [docs/claude-code.md](docs/claude-code.md).

### OpenClaw

```bash
openclaw plugins install @tpsdev-ai/openclaw-flair
```

Auto-detects the agent identity, provides `memory_store` / `memory_recall` / `memory_get`, and injects relevant memories at session start. See the [plugin README](packages/openclaw-flair/README.md).

### n8n

```
Settings → Community Nodes → Install → @tpsdev-ai/n8n-nodes-flair
```

Three nodes: **Flair Chat Memory** (Memory port), **Flair Search** and **Flair Write** (Tool ports). Setup and security guidance in **[docs/n8n.md](docs/n8n.md)** — read the auth note below first.

### Flair CLI

Any agent that can run a shell command can use Flair directly.

```bash
flair memory add --agent mybot "learned something important"
flair search --agent mybot "that important thing"
flair soul set --agent mybot --key role --value "Security reviewer"
flair bootstrap --agent mybot --max-tokens 4000        # cold-start: soul + relevant memories
flair backup --admin-pass-file ~/.flair/admin-pass     # logical JSON export
flair restore ./backup.json --admin-pass-file ~/.flair/admin-pass
```

`--admin-pass-file` is preferred over `--admin-pass`: it keeps the secret out of `ps` and your shell history.

### JavaScript / TypeScript

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

await flair.memory.write('Harper v5 sandbox blocks bare imports')
const results = await flair.memory.search('native module loading')
const ctx = await flair.bootstrap({ maxTokens: 4000 })
await flair.soul.set('role', 'Security reviewer')
```

No Harper, no embeddings — just HTTP and auth. Full API in the [client README](packages/flair-client/README.md).

### HTTP API (any language)

Anything that can make an HTTP request and sign with Ed25519.

```bash
curl -H "Authorization: TPS-Ed25519 mybot:$TS:$NONCE:$SIG" \
  -X POST http://localhost:19926/SemanticSearch \
  -d '{"agentId": "mybot", "q": "deployment procedure", "limit": 5}'

curl -H "Authorization: TPS-Ed25519 mybot:$TS:$NONCE:$SIG" \
  -X PUT http://localhost:19926/Memory/mybot-123 \
  -d '{"id": "mybot-123", "agentId": "mybot", "content": "...", "durability": "standard"}'
```

Sign `agentId:timestamp:nonce:METHOD:/path` with the agent's private key. Protocol in [SECURITY.md](SECURITY.md).

### Embedded in a Harper app (in-process)

Flair *is* a Harper component. If your application already runs on Harper, load Flair into the same instance and call its resources directly — a method call instead of an HTTP round trip.

```javascript
import { server } from "harper";

const Memory = server.resources.get("Memory").Resource;   // the resource, not the table
const h = new Memory(undefined, { request: { tpsAgent: "mybot" } });
await h.post({ agentId: "mybot", content: "...", durability: "standard" });
```

`databases.flair.Memory` is the **table** (raw storage); the exported `Memory` class is the **resource**, where auth, read-scoping, visibility and embedding live. A context-less call runs unfiltered. Full guide: **[docs/embedding-in-a-harper-app.md](docs/embedding-in-a-harper-app.md)**.

### Auth across surfaces

The default everywhere is **Ed25519 per-agent**: each agent holds its own key at `~/.flair/keys/<agent>.key` and signs every request. That gives write isolation — no agent can write as another — and identity-verified reads. It does *not* refuse cross-agent reads: within one instance, any verified agent can read any other agent's non-private memory by design. The hard boundary is the federation edge, not intra-instance reads. See [SECURITY.md](SECURITY.md).

One exception: the **`n8n-nodes-flair`** node authenticates with the Harper **admin password** (Basic auth), which bypasses agent scoping entirely — it can read other agents' `visibility: private` memories and write as anyone. That is acceptable only on a single-tenant, operator-controlled n8n with trusted workflow inputs. Otherwise prefer the Ed25519 path. Full breakdown in **[docs/auth.md](docs/auth.md#auth-across-surfaces-read-this-first)**.

## Deployment

### Local (default)

```bash
flair init --agent mybot
```

Data stays on your machine. A single Harper process — no Docker, no cloud, no external services. If port `19926` is taken, `flair init --port 8000` records the choice in `~/.flair/config.yaml` for future commands.

### Remote Server

Run Flair on a VPS or cloud instance; agents connect over HTTPS.

```bash
# On the server
flair init --agent mybot --port 19926

# On each client — --target seeds the agent on the remote instance
flair agent add otherbot --target https://your-server:19926
```

`--target` derives the operations API as *REST port − 1*. If that isn't where your ops API lives, pass `--ops-target` explicitly. Good for teams with multiple machines or always-on agents.

### Harper Fabric

Managed hosting with multi-region replication and failover. Federation runs against Harper Fabric hubs — pair your local instance to sync memories across nodes. Full guide: **[docs/deploying-on-fabric.md](docs/deploying-on-fabric.md)**.

## Security

Full model, threat analysis and recommendations in [SECURITY.md](SECURITY.md).

- Ed25519 cryptographic identity — agents sign every request.
- Writes are always agent-scoped. An agent can only write its own records.
- Reads are open within the org: any agent can read any other agent's non-private memory, no grant required. `private` is the one owner-only exception ([DESIGN.md](DESIGN.md#access-model-open-within-the-org-closed-at-the-federation-edge)).
- The admin password is generated by `flair init` and written to `~/.flair/admin-pass` (mode 0600). The CLI prints the path, never the value. Prefer `--admin-pass-file` over `--admin-pass` so it stays out of `ps` and shell history.
- Key rotation via `flair agent rotate-key`.

## Architecture

```
flair/
├── src/cli.ts                 # CLI: init, agent, status, backup, grant
├── config.yaml                # Harper app configuration
├── schemas/*.graphql          # Agent, Memory, Soul, Federation, OAuth tables
├── resources/
│   ├── auth-middleware.ts     # Ed25519 verification + agent scoping
│   ├── embeddings-provider.ts # In-process nomic embeddings
│   ├── Memory.ts              # Durability enforcement + auto-embed
│   ├── Soul.ts                # Permanent-by-default personality
│   ├── SemanticSearch.ts      # Hybrid semantic + keyword search
│   ├── MemoryBootstrap.ts     # Cold-start context assembly
│   └── MemoryFeed.ts          # Real-time memory changes
├── packages/                  # flair-mcp, flair-client, openclaw-flair, n8n-nodes-flair,
│                              # langgraph-flair, hermes-flair, pi-flair, flair-bench
└── SECURITY.md                # Threat model + auth documentation
```

Key decisions:

- **Harper-native** — no Express, no middleware framework. Harper *is* the runtime.
- **In-process embeddings** — [nomic-embed-text](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF) via [llama.cpp](https://github.com/ggerganov/llama.cpp), CPU or GPU. No OpenAI key needed.
- **Schema-driven** — GraphQL `@table @export` auto-generates REST CRUD; custom resources add durability guards, auto-embedding and search.

## Development

```bash
bun install          # install dependencies
bun run build        # compile TypeScript → dist/
bun test             # unit + integration tests
```

Integration tests spin up a real Harper instance on a random port and tear it down afterwards — no mocks for the database layer. Every commit runs unit tests, integration tests, type check, dependency audit, Semgrep and CodeQL SAST, and a from-scratch Docker validation. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Status

Flair is in active development and daily use. We dogfood it: the agents that build Flair use Flair for their own memory and identity.

Shipped: Ed25519 identity and auth · memory CRUD with durability enforcement and near-duplicate detection · in-process semantic embeddings · hybrid search with temporal intent detection · soul · relationship graph · auto entity detection · temporal validity · real-time feeds · predictive bootstrap · federation · OAuth 2.1 and XAA · web admin · REM memory hygiene · MCP server · OpenClaw plugin · client library · portable agent export/import · `flair upgrade`.

Next: git-backed memory sync · opt-in encryption at rest (AES-256-GCM per memory).

> **Note:** Flair runs on [Harper v5](https://harper.fast), currently in beta. We run it in production daily and track upstream closely. Pin your Harper version.

## License

[Apache 2.0](LICENSE)
