# Flair integrations

Where Flair already runs. Each integration shown here is a working surface — the same memory, federated across all of them, scoped per-agent by Ed25519 keys.

> **The point.** Memory should follow the agent across orchestrators. Every entry below pulls from the same Flair instance, sees the same `agentId` namespace, respects the same isolation. Pick whichever harness you're shipping in; the memory layer doesn't care.

---

## Quick install matrix

| Surface | Install path | Auth | Notes |
|---------|--------------|------|-------|
| **Claude Code** | [`flair-mcp`](#claude-code-cursor-codex-gemini-cli-continuedev-via-flair-mcp) | MCP config | Standard MCP server |
| **Cursor** | [`flair-mcp`](#claude-code-cursor-codex-gemini-cli-continuedev-via-flair-mcp) | MCP config | Standard MCP server |
| **Continue.dev** | [`flair-mcp`](#claude-code-cursor-codex-gemini-cli-continuedev-via-flair-mcp) | MCP config | Standard MCP server |
| **OpenAI Codex CLI** | [`flair-mcp`](#claude-code-cursor-codex-gemini-cli-continuedev-via-flair-mcp) | MCP config | Standard MCP server |
| **Gemini CLI** | [`flair-mcp`](#claude-code-cursor-codex-gemini-cli-continuedev-via-flair-mcp) | MCP config | Standard MCP server |
| **Goose** (block/goose) | [`flair-mcp`](#claude-code-cursor-codex-gemini-cli-continuedev-via-flair-mcp) | MCP config | Goose ships native MCP support |
| **LangGraph (TS)** | [`langgraph-flair`](#langgraph-typescript) | FlairClient | Drop-in `BaseStore` |
| **OpenClaw** | [`openclaw-flair`](#openclaw) | Ed25519 | Native plugin + context engine |
| **n8n** | [`n8n-nodes-flair`](#n8n) | FlairApi credential | Three nodes (chat memory, search, store) |
| **Hermes Agent** | [`hermes-flair`](#hermes-agent) | Ed25519 | Python `MemoryProvider` |
| **Pi agent** | [`pi-flair`](#pi-agent) | Ed25519 | TS plugin |

Don't see your harness? If it speaks **MCP** — Flair already works with `flair-mcp`. If it has a **custom memory protocol** like LangGraph's `BaseStore` or CrewAI's `RAGStorage`, an adapter is a ~200-line package; [open an issue](https://github.com/tpsdev-ai/flair/issues) or [send a PR](https://github.com/tpsdev-ai/flair).

**Adjacent: memory bridges** — for moving memories between Flair and another memory product. Five bridges ship today (Mem0, ChatGPT exports, claude-project files, agentic-stack, markdown); see [bridges.md](bridges.md). Bridges are import/export plumbing, not live orchestrator integrations.

---

## Claude Code, Cursor, Codex, Gemini CLI, Continue.dev, Goose — via `flair-mcp`

[`@tpsdev-ai/flair-mcp`](https://www.npmjs.com/package/@tpsdev-ai/flair-mcp) is a [Model Context Protocol](https://modelcontextprotocol.io/) server that exposes Flair as a memory tool to any MCP-speaking client. One server, every MCP client.

No install step needed — every snippet below uses `npx -y @tpsdev-ai/flair-mcp`, which fetches and runs the server on demand (zero-install). The fastest path is `flair init`, which detects and wires these clients for you. To wire by hand, drop the relevant snippet into each tool's MCP config:

**Claude Code** (`~/.config/claude-code/config.toml` or per-project `.claude/config.toml`):
```toml
[mcp.servers.flair]
command = "npx"
args = ["-y", "@tpsdev-ai/flair-mcp"]
env = { FLAIR_AGENT_ID = "claude-code" }
```

**Cursor** (`~/.cursor/mcp.json`):
```json
{
  "mcpServers": {
    "flair": {
      "command": "npx",
      "args": ["-y", "@tpsdev-ai/flair-mcp"],
      "env": { "FLAIR_AGENT_ID": "cursor" }
    }
  }
}
```

**Codex CLI** (`~/.codex/config.toml`):
```toml
[mcp_servers.flair]
command = "npx"
args = ["-y", "@tpsdev-ai/flair-mcp"]

[mcp_servers.flair.env]
FLAIR_AGENT_ID = "codex"
```

**Gemini CLI** (`~/.gemini/settings.json`): same shape as Cursor.

**Continue.dev** (`~/.continue/config.json`):
```json
{
  "experimental": {
    "modelContextProtocolServer": {
      "command": "npx",
      "args": ["-y", "@tpsdev-ai/flair-mcp"],
      "env": { "FLAIR_AGENT_ID": "continue" }
    }
  }
}
```

**Goose** (`~/.config/goose/profiles.yaml`):
```yaml
default:
  extensions:
    flair:
      cmd: npx
      args: ["-y", "@tpsdev-ai/flair-mcp"]
      envs: { FLAIR_AGENT_ID: goose }
```

**Auth.** Set `FLAIR_AGENT_ID` to whatever identifier you want this client to claim. The MCP server will prompt you to register that agent on first call (`flair agent add <id>` writes the Ed25519 keypair). Subsequent calls auto-load the key.

Full per-tool walkthrough including troubleshooting: [`docs/mcp-clients.md`](mcp-clients.md).

---

## LangGraph (TypeScript)

[`@tpsdev-ai/langgraph-flair`](https://www.npmjs.com/package/@tpsdev-ai/langgraph-flair) implements LangGraph's `BaseStore`. Drop-in for `InMemoryStore`.

```bash
npm install @tpsdev-ai/langgraph-flair
```

```typescript
import { FlairStore } from "@tpsdev-ai/langgraph-flair";
import { createReactAgent } from "@langchain/langgraph/prebuilt";

const store = new FlairStore({ agentId: "my-langgraph-agent" });
const agent = createReactAgent({ llm, tools, store });
```

Maps LangGraph namespaces to Flair tags, keys to ids, values to JSON content. Search delegates to Flair's HNSW. Filter operators applied client-side. Full mapping table: [`packages/langgraph-flair/README.md`](../packages/langgraph-flair/README.md).

LangGraph **Python** support is on the roadmap (same `BaseStore` shape, Python adapter).

---

## OpenClaw

[`@tpsdev-ai/openclaw-flair`](https://www.npmjs.com/package/@tpsdev-ai/openclaw-flair) is the native OpenClaw plugin. Adds Flair as a memory provider AND registers the `flair` context engine that re-injects PERMANENT-tier rules (SOUL.md, IDENTITY.md, AGENTS.md) every turn.

```bash
openclaw plugins install @tpsdev-ai/openclaw-flair
```

Configuration via OpenClaw's standard plugin surface. See [`docs/openclaw.md`](openclaw.md) for the per-agent install pattern, including how to wire SOUL.md so behavioral anchors persist across long sessions without drift.

---

## n8n

[`@tpsdev-ai/n8n-nodes-flair`](https://www.npmjs.com/package/@tpsdev-ai/n8n-nodes-flair) ships three nodes:

- **FlairChatMemory** — drop-in chat-memory for n8n's AI Agent / LangChain workflow nodes. Same role as Postgres / Redis chat memory but with cross-orchestrator portability.
- **FlairSearch** — semantic search over your Flair memories from any workflow.
- **FlairApi** credential — Ed25519 keypair entry point for the agentId.

Install via the standard n8n community-node UI (Settings → Community nodes → `@tpsdev-ai/n8n-nodes-flair`) or:

```bash
cd ~/.n8n && npm install @tpsdev-ai/n8n-nodes-flair
```

Walkthrough including a worked example flow: [`docs/n8n.md`](n8n.md).

---

## Hermes Agent

[`hermes-flair`](https://github.com/tpsdev-ai/flair/tree/main/packages/hermes-flair) implements Nous Research [Hermes](https://github.com/NousResearch/hermes-agent)'s `MemoryProvider` plugin contract in Python. Bootstrap injection at session start, background prefetch between turns, two tools (`flair_search`, `flair_store`), built-in MEMORY.md mirroring, circuit breaker.

```bash
hermes plugins install path:/path/to/flair/packages/hermes-flair
```

Auth: TPS-Ed25519 (the same model the rest of Flair uses) — writes are isolated per agent identity server-side; reads are open within the org for non-private memories, with `visibility: private` staying owner-only. See [SECURITY.md](../SECURITY.md).

---

## Pi agent

[`@tpsdev-ai/pi-flair`](https://www.npmjs.com/package/@tpsdev-ai/pi-flair) is the TS plugin for the [Pi coding agent](https://github.com/mariozechner/pi-coding-agent). Memory + identity for the Pi runtime.

```bash
npm install @tpsdev-ai/pi-flair
```

Pi resolves the plugin via its standard plugin config; pin `agentId` per host.

---

## Don't see your harness?

If it speaks MCP, you're already covered — every MCP client works through `flair-mcp` (the section above lists 6 we've explicitly tested).

If it has a custom memory protocol, the adapter pattern is small (~200 lines). LangGraph and Hermes are the reference implementations. **Adapters we'd love to see:**

- LangGraph Python (mirror of our TS adapter)
- CrewAI (Python `BaseRAGStorage` protocol)
- AG2 / AutoGen (Python)
- Mastra (TS, denser thread model)
- ADK (Google, Python + TS)

[Open an issue](https://github.com/tpsdev-ai/flair/issues) describing the harness and we'll triage. PRs welcome — see [`packages/langgraph-flair`](../packages/langgraph-flair) as the smallest-shape reference.

---

## See also

- [Quickstart](quickstart.md) — `flair init` to working memory in 30 seconds
- [Memory bridges](bridges.md) — import/export Flair ↔ Mem0, ChatGPT, claude-project, markdown, agentic-stack (five bridges shipped)
- [Federation](federation.md) — pair instances peer-to-peer for cross-machine sync
- [Supply-chain policy](supply-chain-policy.md) — what we do to keep this list of integrations safe
- [The team](the-team.md) — the multi-agent rig that builds Flair, dogfooded on every harness above
