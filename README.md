# 🎖️ Flair

[![CI](https://github.com/tpsdev-ai/flair/actions/workflows/test.yml/badge.svg)](https://github.com/tpsdev-ai/flair/actions/workflows/test.yml)
[![Docker Test](https://github.com/tpsdev-ai/flair/actions/workflows/docker-test.yml/badge.svg)](https://github.com/tpsdev-ai/flair/actions/workflows/docker-test.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

> **The identity and memory substrate for AI agents. Crypto-pinned. Federated. Self-hosted.**

Every agent framework gives you chat history. None give you *identity*. Flair gives an agent three things that survive a restart and follow it between orchestrators: an **identity** it proves with an Ed25519 keypair, **memory** it searches by meaning rather than by keyword, and a **soul** — the personality, values and procedures that make it *that* agent.

## Quick start

Runs on a laptop, a VPS, or anywhere Node does. Needs **Node.js 22+**.

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

`flair init` installs and starts Harper, creates the agent's Ed25519 keypair, verifies semantic search actually works, wires every MCP client it detects (Claude Code, Cursor, Codex CLI, Gemini CLI), and runs a smoke test. Restart your MCP client afterwards, then ask the agent *"what do you remember about me?"*

> **Pass `--agent`.** A bare `flair init` bootstraps the instance and stops there — no agent, no keypair, no MCP wiring.

Full walkthrough with expected output at every step: **[docs/quickstart.md](docs/quickstart.md)**.

### One install, one binary

`npm install -g @tpsdev-ai/flair` puts a single command on your `PATH`: `flair`. That is the whole install, and it needs a **user-writable npm global prefix** — which is why step 1 says *no sudo*. A root-owned install can't write the embedding model into its own package directory, so semantic search silently degrades to keyword-only. Use `nvm`, or point npm at your home directory — `npm config set prefix ~/.npm-global`, then add `~/.npm-global/bin` to `PATH`. `flair init` and `flair doctor` both check for this and say so loudly.

Two different things get called "MCP" here, and you get them differently:

- **The server has an MCP surface built in.** `/mcp` is a JSON-RPC endpoint exposing 12 curated tools, guarded by OAuth bearer tokens. It ships inside the package — and it is **off by default**: until you set `FLAIR_MCP_OAUTH` *and* a public issuer (`FLAIR_MCP_ISSUER`, falling back to `FLAIR_PUBLIC_URL`), no `/mcp` route is registered and the path returns 404. No documented client setup uses it today.
- **What your MCP client actually talks to is a separate package** — `@tpsdev-ai/flair-mcp`, a stdio adapter — and that one is deliberately not installed globally. `flair init` writes `npx -y @tpsdev-ai/flair-mcp@<version>` into each client's config, pinned to the CLI's own version, so the client fetches it on demand and there is no second global package to keep in step.

`@tpsdev-ai/flair-client` is likewise its own package: add it to a project when you want to call Flair from your own code ([JavaScript / TypeScript](#javascript--typescript)).

### Where the agent's key lives

`flair init --agent mybot` writes the private key to `~/.flair/keys/mybot.key` (mode `0600`) and the public half beside it as `mybot.pub`. Only the **public** key is registered on the instance; the private key never leaves the machine. `--keys-dir` writes both somewhere else.

**Back that file up — it is the agent's identity, and there is one copy.** Memories are not encrypted with it, so losing it costs the identity, not the data: the agent can no longer sign, and every HTTP call it makes fails. Recovery is `flair agent rotate-key mybot`, which mints a new pair and re-registers the public half — it needs the admin password `flair init` wrote to `~/.flair/admin-pass`, so back that up too. Otherwise treat the key like an SSH key: one per agent per host, never copied between machines ([docs/secrets-and-keys.md](docs/secrets-and-keys.md)).

Keys are how an agent *outside* the process proves who it is. Code running inside the same Harper instance needs no key at all — see [Embedded in a Harper app](#embedded-in-a-harper-app-in-process).

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

## One agent, every harness

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

## How it works

Flair is a native [Harper v5](https://harper.fast) application. Harper handles HTTP, persistence (RocksDB), and application logic in one process — self-hosted, with no sidecars, no vector database and no embedding API.

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

Trust-graded recall reaches the authenticated HTTP API and the built-in `/mcp` tools today — the latter being off by default, see [One install, one binary](#one-install-one-binary). CLI, `@tpsdev-ai/flair-client` and `flair-mcp` exposure is a follow-up. REM needs a configured generative backend (Ollama, OpenAI, Anthropic, …) — without one, `flair rem rapid` fails with `Reflection error: No generative backend configured`.

## How Flair compares

Every product here does semantic recall over stored memories. These are the dimensions they actually differ on.

| | Flair | Mem0 | Honcho | Letta (MemGPT) | [SageOx](https://sageox.ai) | Built-ins (OAI/Anthropic/Google) |
|---|---|---|---|---|---|---|
| **Where memories live** | infrastructure you run | self-host or Mem0 Cloud | self-host or hosted API | self-host or Letta Cloud | SageOx cloud | vendor cloud |
| **Memory is scoped to** | the agent, via an Ed25519 keypair | tenant / user | per-user tenant | the runtime | the team | the account |
| **Reaches other orchestrators** | 11 harnesses, incl. workflow and agent frameworks | several | several | Letta's runtime | 14+ coding agents and editors, via hooks, plugins and instruction files | no |
| **Sync between instances you run** | hub/spoke federation | no | no | no | one hosted service | one hosted service |
| **Captures in-person conversation** | no | no | no | no | yes — Ox Dot | no |
| **Per-agent persistent character** | first-class (Soul) | optional | persona-shaped | optional | team context, not per-agent | no |

**Where Flair loses.** [SageOx's Ox Dot](https://sageox.ai) records in-person meetings, standups and whiteboard sessions and pipes them into shared context; Flair has no ambient capture of anything that isn't already text in a tool. Mem0's hosted sync is more polished. Honcho's persona model is more developed. Letta's integration with its own agent loop is tighter than anything Flair offers. And there is no Flair-operated cloud — running it is your job.

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

(`mcp__flair__bootstrap` is Claude Code's namespaced name for the server's `bootstrap` tool.) Use `flair bootstrap --agent <id>` when MCP is not wired — previewing context, scripts, or any agent that can run a shell command.

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

The second front door, and the one to take if your code already runs on Harper.

Flair *is* a Harper component. Deploy it into the instance your application already runs in and call its resources directly — `await h.post({ agentId, content })` is a **method call**, not a network call. No second service to operate, no HTTP round trip, and no key to distribute: a caller in the same process is already inside the trust boundary and names the agent it is acting as, per call.

Adding it takes nothing away. The HTTP surface keeps serving MCP clients and remote agents exactly as before.

```javascript
import { server } from "harper";
import { agentContext, collectionResource } from "@tpsdev-ai/flair/dist/resources/in-process.js";

// The RESOURCE — auth, read-scoping, visibility, embedding.
// Registry keys carry no leading slash: get("Memory"), never get("/Memory").
const Memory = server.resources.get("Memory").Resource;

const h = await collectionResource(Memory, agentContext("mybot"));
await h.post({ agentId: "mybot", content: "...", durability: "standard" });
```

`databases.flair.Memory` is the **table** (raw storage); the exported `Memory` class is the **resource**, where auth, read-scoping, visibility and embedding live. `new Memory(...)` is not a substitute for `collectionResource` — a create needs a collection-bound instance only Harper can produce. Both helpers refuse a missing agent id rather than defaulting it, because a resource invoked with no context resolves to Flair's trusted `internal` verdict and runs unfiltered across every agent.

**This path needs no key at all.** Keys are how an agent *outside* the process proves who it is. Code running inside the same Harper instance asserts identity through the call context instead — `agentContext("mybot")` — which Flair reads and acts on with no signature, no `Agent`-table lookup and no registration. That is deliberate: same-process code could write the storage tables directly, so demanding a signature from it would be theatre. It is also why that id must come from your own server-side state and never from request data.

**→ [Embedding Flair in a Harper app](docs/embedding-in-a-harper-app.md)** — the whole in-process contract, measured against a real instance: resolving the resource, the table-vs-resource distinction that decides whether your memories are scoped at all, N agents in one process, and registering agents with no shell on the node.

### Auth across surfaces

For every caller that reaches Flair over the network the default is **Ed25519 per-agent**: each agent holds its own key at `~/.flair/keys/<agent>.key` and signs every request. That gives write isolation — no agent can write as another — and identity-verified reads. It does *not* refuse cross-agent reads: within one instance, any verified agent can read any other agent's non-private memory by design. The hard boundary is the federation edge, not intra-instance reads. See [SECURITY.md](SECURITY.md).

One exception: the **`n8n-nodes-flair`** node authenticates with the Harper **admin password** (Basic auth), which bypasses agent scoping entirely — it can read other agents' `visibility: private` memories and write as anyone. That is acceptable only on a single-tenant, operator-controlled n8n with trusted workflow inputs. Otherwise prefer the Ed25519 path. Full breakdown in **[docs/auth.md](docs/auth.md#auth-across-surfaces-read-this-first)**.

In-process callers are a different model, not an exception to this one: they never sign, because identity is asserted through the call context rather than proven. Co-location *is* the grant — which is why Flair beside untrusted co-tenants on a shared instance is a different proposition to Flair inside your own app.

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

Managed hosting with multi-region replication and failover. Need a public URL for Cursor / Grok Bot / cloud agents? Start at **[docs/quickstart-fabric.md](docs/quickstart-fabric.md)**. Federation, pairing, and operator detail: **[docs/deploying-on-fabric.md](docs/deploying-on-fabric.md)**.

## Security

Full model, threat analysis and recommendations in [SECURITY.md](SECURITY.md).

- Ed25519 cryptographic identity — agents sign every request.
- Writes are always agent-scoped. An agent can only write its own records.
- Reads are open within the org: any agent can read any other agent's non-private memory, no grant required. `private` is the one owner-only exception ([DESIGN.md](DESIGN.md#access-model-open-within-the-org-closed-at-the-federation-edge)).
- Which memories are non-private is decided at write time, from durability: `permanent`/`persistent` default to `shared`, `standard`/`ephemeral` to `private`. A write that names neither is `standard`, so it lands `private`. Say what you mean with `--visibility shared|private` (CLI) or `visibility` (MCP / SDK); a write response names the visibility the record landed on, so it never has to be inferred.
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

> **Note:** Flair runs on [Harper v5](https://harper.fast). We run it in production daily and track upstream closely. Pin your Harper version.

## License

[Apache 2.0](LICENSE)
