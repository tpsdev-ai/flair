# Flair + n8n

Use Flair as the memory backend for n8n's AI Agent. The same memories are readable from Claude Code, OpenClaw, and any other Flair client — that's the point.

## When to use Flair vs n8n's built-in memory connectors

n8n ships memory connectors for Postgres, MongoDB, and Redis. Those are real, persistent, and work fine for **conversation-buffer** use cases inside a single n8n instance.

Flair is the right pick when you want:

| | Flair | n8n built-ins |
|---|---|---|
| **Shape** | Tagged + typed memories with semantic search, plus chat-buffer compatibility | Conversation-buffer only (LangChain `BaseMessage` records) |
| **Cross-orchestrator** | Same memory readable from Claude Code, OpenClaw, n8n | n8n-internal schema; nothing else reads it |
| **Cross-instance** | Hub-spoke federation built-in (rockit ↔ Fabric, etc.) | Single-instance unless you self-build replication |
| **Identity** | Ed25519 per-agent (post-1.0) or admin-token (v1) | n8n credential per workflow |

If your AI Agent only needs to remember the last N turns of a single chat in a single n8n instance, Postgres-as-memory is fine. If you want the same memory to inform a Claude Code conversation tomorrow, or to persist across n8n redeploys via federated Flair, this package is the path.

## Setup (5 minutes)

### 1. Install Flair (if not already running)

```bash
npm install -g @tpsdev-ai/flair
flair init
```

This starts a local Flair server on `http://localhost:9926`. For shared/team setups, see [Deployment](./deployment.md).

### 2. Install the n8n community node

In n8n: **Settings → Community Nodes → Install** → enter `@tpsdev-ai/n8n-nodes-flair` → confirm and restart.

### 3. Create the credential

In n8n: **Credentials → New → Flair API**. Fill in:

| Field | Value |
|---|---|
| **Base URL** | `http://localhost:9926` (or your team's Flair URL) |
| **Agent ID** | Logical identity that will own memories from this n8n workspace. Workflows that share an Agent ID share memory ownership. Use distinct IDs when isolation matters. |
| **Admin Password** | Your Flair admin password (in `~/.flair/admin-pass` for local installs). **Sensitive** — see [Security](#security). |

Click **Test** — if the test request to `/Memory` returns 200, the credential is good.

### 4. Wire the nodes

Two nodes ship in the package:

- **Flair Chat Memory** — connects to an AI Agent's `Memory` socket. Stores chat history in Flair, scoped by Subject. Defaults to per-workflow memory; set the optional Session Sub-Key to `={{ $execution.id }}` for per-run isolation.
- **Flair Search** — connects to an AI Agent's `Tool` socket. Two operations:
  - *Semantic Search* — agent calls `flair_search({ query })`, gets memories ranked by similarity.
  - *Get By Subject* — agent calls `flair_get_by_subject()`, gets memories under a config-time-bound subject.

A typical workflow:

```
[Webhook] → [AI Agent]
              ├─ Model: Claude / OpenAI / etc.
              ├─ Memory: Flair Chat Memory (Subject: customer-support)
              ├─ Tool: Flair Search (Operation: Semantic Search)
              └─ Tool: HTTP Request (etc.)
```

The agent now answers using both its current chat history (from Flair Chat Memory) and any relevant historical memories it pulls in via Flair Search.

## Subject and SessionId guidance

n8n memory connectors expose a `sessionKey` parameter that scopes the chat history. Flair has a richer model:

- **Subject** (required) — the entity / conversation / topic the memory is about. Indexed in Flair's schema; efficient to filter on. Default: `={{ $workflow.name }}`.
- **Session Sub-Key** (optional) — appended to the subject as `<subject>:<sessionKey>`. Use the n8n execution id (`={{ $execution.id }}`) for per-run isolation, or a customer/user id for per-customer scoping, or leave blank to share across runs.

Patterns:

- **"This assistant remembers"** — set Subject to a stable string (`customer-support`, `daily-standup`). Leave Session Sub-Key blank. All runs share memory.
- **Per-conversation isolation** — set Subject to the conversation owner (`customer:1234`), leave Session Sub-Key blank. Each conversation is isolated by subject.
- **Per-execution isolation** — set Session Sub-Key to `={{ $execution.id }}`. Each n8n run gets its own memory window. (This is most similar to n8n's default `sessionKey={{ $execution.id }}`.)

## Security

> **The admin password gives every workflow with this credential read/write access to the entire Flair instance**, not just the configured Agent ID. The blast radius is the whole memory store. Treat the credential as highly sensitive: n8n encrypts credentials at rest, but any n8n admin or backup restore can extract it.

For production deployments where untrusted workflow inputs reach Flair, wait for **Ed25519 per-agent authentication** — tracked as `ops-q3qf-followup` in the spec. v1 (admin password) is appropriate when:

- The n8n instance is single-tenant and operator-controlled
- Workflow inputs are trusted (your own CRM, your own webhook source)
- Memory leakage between agents is acceptable for the use case

If any of those don't hold, use Flair's CLI / SDK clients (which support per-agent Ed25519 today) and wait for the n8n credential update.

## Get By Tag — coming soon

The Flair Search node currently exposes Semantic Search and Get By Subject. **Get By Tag** is deferred until `flair-client.memory.list` exposes a `tags` filter (tracked in the [n8n-node spec](https://github.com/tpsdev-ai/flair/blob/main/specs/N8N-NODE-q3qf.md) §6). Workaround for now: use Semantic Search and let the model filter results by tags in the response.

## Worked examples

Two example workflows ship in the package's `examples/` directory:

- **`chat-memory-demo.json`** — Webhook → AI Agent (Claude + Flair Chat Memory) → Respond. Demonstrates the conversation-buffer use case. Run twice with the same input to see memory replay.
- **`knowledge-search-demo.json`** — Schedule → AI Agent (Claude + Flair Chat Memory + Flair Search as Tool) → action. Demonstrates the structured-knowledge-search use case.

Import via **Workflows → Import from File** in n8n.

## Compared to other Flair surfaces

| Surface | Use case | Setup |
|---|---|---|
| [Claude Code](./claude-code.md) | Personal AI assistant memory across CLI sessions | npm install + `flair init` |
| [OpenClaw](./openclaw.md) | Multi-agent OpenClaw deployments | OpenClaw plugin install |
| [MCP](./mcp-clients.md) | Any MCP client (Claude Desktop, etc.) | MCP server registration |
| **n8n (this doc)** | Workflow-engine AI Agents | n8n community-node install |

Same Flair instance, same memories, different surfaces.

## See also

- [Spec — `@tpsdev-ai/n8n-nodes-flair`](https://github.com/tpsdev-ai/flair/blob/main/specs/N8N-NODE-q3qf.md) — implementation plan, design decisions, anti-patterns
- [Bridges](./bridges.md) — how Flair memories flow between hosts and instances
- [Federation](./federation.md) — hub-and-spoke replication
