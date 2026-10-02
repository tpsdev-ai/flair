# Flair + n8n

Use Flair as the memory backend for n8n's AI Agent. The same memories are readable from Claude Code, OpenClaw, and any other Flair client — that's the point.

## When to use Flair vs n8n's built-in memory connectors

n8n ships memory connectors for Postgres, MongoDB, and Redis. Those are real, persistent, and work fine for **conversation-buffer** use cases inside a single n8n instance.

Flair is the right pick when you want:

| | Flair | n8n built-ins |
|---|---|---|
| **Shape** | Tagged + typed memories with semantic search, plus chat-buffer compatibility | Conversation-buffer only (LangChain `BaseMessage` records) |
| **Cross-orchestrator** | Same memory readable from Claude Code, OpenClaw, n8n | n8n-internal schema; nothing else reads it |
| **Cross-instance** | Hub-spoke federation built-in (local ↔ Fabric, etc.) | Single-instance unless you self-build replication |
| **Identity** | Ed25519 with Agent Private Key selected; the v1 admin password is still accepted, deprecated | n8n credential per workflow |

If your AI Agent only needs to remember the last N turns of a single chat in a single n8n instance, Postgres-as-memory is fine. If you want the same memory to inform a Claude Code conversation tomorrow, or to persist across n8n redeploys via federated Flair, this package is the path.

## Setup (5 minutes)

### 1. Install Flair (if not already running)

```bash
npm install -g @tpsdev-ai/flair
flair init
```

This starts a local Flair server on `http://localhost:19926`. For shared/team setups, see [Deployment](./deployment.md).

### 2. Install the n8n community node

In n8n: **Settings → Community Nodes → Install** → enter `@tpsdev-ai/n8n-nodes-flair` → confirm and restart.

### 3. Create the credential

In n8n: **Credentials → New → Flair API**. Fill in:

| Field | Value |
|---|---|
| **Base URL** | `http://localhost:19926` (or your team's Flair URL) |
| **Agent ID** | The memory owner and, with Agent Private Key selected, signing identity, e.g. `n8n-support`. Workflows that share an Agent ID share memory ownership. |
| **Agent Private Key** | That agent's Ed25519 private key. |

Mint a key once per agent identity you want a workflow to use:

```bash
flair agent add n8n-support
base64 < ~/.flair/keys/n8n-support.key
```

Paste the base64 output into **Agent Private Key**.

Click **Test** — it reads `/Memory` using the selected auth mode and reports that mode on success.

**Admin Password (deprecated)** — used only with Agent Private Key empty. Requests use Harper administrator Basic authentication, including access to other agents' private memories, and each node execution warns.

### 4. Wire the nodes

Three nodes ship in the package:

- **Flair Chat Memory** — connects to an AI Agent's `Memory` socket. Stores chat history in Flair, scoped by Subject. Defaults to per-workflow memory; set the optional Session Sub-Key to `={{ $execution.id }}` for per-run chat-history grouping by subject.
- **Flair Search** — connects to an AI Agent's `Tool` socket. Two operations:
  - *Semantic Search* — agent calls `flair_search({ query })`, gets memories ranked by similarity.
  - *Get By Subject* — agent calls `flair_get_by_subject()`, gets memories under a config-time-bound subject.
- **Flair Write** — a regular Main-input/Main-output pipeline node (not wired to the AI Agent's Tool socket). Takes an incoming item and writes its content as a Flair memory, with Subject, Tags, and Durability fields. For operator-driven capture-and-archive flows (mail → memory, webhook → memory, parsed-doc → memory) where the write is the workflow author's choice, not the LLM's.

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

- **Subject** (required) — the entity / conversation / topic the memory is about. For Flair Search Get By Subject, the client compares subjects after retrieval and the node requests no ordering. Default: `={{ $workflow.name }}`.
- **Session Sub-Key** (optional) — appended to the subject as `<subject>:<sessionKey>`. Use the n8n execution id (`={{ $execution.id }}`) for per-run chat-history grouping by subject, or a customer/user id for per-customer scoping, or leave blank to share across runs.

Patterns:

- **"This assistant remembers"** — set Subject to a stable string (`customer-support`, `daily-standup`). Leave Session Sub-Key blank. All runs share memory.
- **Per-conversation grouping** — set Subject to a unique conversation ID (for example, `conversation:abc123`) and leave Session Sub-Key blank. Runs using the same Agent ID and conversation ID select the same chat history; different conversation IDs select different histories.
- **Per-execution grouping** — set Session Sub-Key to `={{ $execution.id }}`. A distinct subject selects each conversation's or run's chat-history window; it does not restrict access to those memories. (This is most similar to n8n's default `sessionKey={{ $execution.id }}`.)

## Security

With Agent Private Key selected, requests sign as the credential's Agent ID. Ordinary agents write their own memories and read their own plus other agents' non-private memories; administrator-role agents have broader authority.

The deprecated **Admin Password** path uses Harper administrator Basic authentication, with access to other agents' private memories. It is used only while Agent Private Key is empty, and every execution that uses it logs a warning. To migrate a credential still using it, mint an agent key (step 3) and fill in Agent Private Key.

Treat the key as a secret.

## Get By Tag

The Flair Search node currently exposes Semantic Search and Get By Subject. **Get By Tag** is not yet exposed as an operation. The `memory.list` client does support the `tags` filter — use it directly via the SDK for agent-driven tag filtering.

## Worked examples

Two example workflows are coming in a follow-up release; they're authored inside a real n8n instance and round-tripped via Export so they import cleanly:

- **`chat-memory-demo.json`** — Webhook → AI Agent (Claude + Flair Chat Memory) → Respond. Demonstrates the conversation-buffer use case. Run twice with the same input to see memory replay.
- **`knowledge-search-demo.json`** — Schedule → AI Agent (Claude + Flair Chat Memory + Flair Search as Tool) → action. Demonstrates the structured-knowledge-search use case.

In the interim, follow the [Setup](#setup-5-minutes) and [Subject and SessionId guidance](#subject-and-sessionid-guidance) sections — wiring is straightforward without an example file.

## Compared to other Flair surfaces

| Surface | Use case | Setup |
|---|---|---|
| [Claude Code](./claude-code.md) | Personal AI assistant memory across CLI sessions | npm install + `flair init` |
| [OpenClaw](./openclaw.md) | Multi-agent OpenClaw deployments | OpenClaw plugin install |
| [MCP](./mcp-clients.md) | Any MCP client (Claude Desktop, etc.) | MCP server registration |
| **n8n (this doc)** | Workflow-engine AI Agents | n8n community-node install |

Same Flair instance, same memories, different surfaces.

## See also

- [Bridges](./bridges.md) — how Flair memories flow between hosts and instances
- [Federation](./federation.md) — hub-and-spoke replication
