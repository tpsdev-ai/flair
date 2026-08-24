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
| **Antigravity CLI** (`agy`) | [`flair-mcp`](#claude-code-cursor-codex-gemini-cli-continuedev-via-flair-mcp) | MCP config | `~/.gemini/config/mcp_config.json`; pickup by a live `agy` pending verification |
| **Goose** (block/goose) | [`flair-mcp`](#claude-code-cursor-codex-gemini-cli-continuedev-via-flair-mcp) | MCP config | Goose ships native MCP support |
| **DeepSeek Harness** (`dsh`) | [`flair-mcp`](deepseek-harness.md) | Cordis overlay | First-party MCP bridge; tools-only, reactive recall — [dedicated page](deepseek-harness.md) |
| **LangGraph (TS)** | [`langgraph-flair`](#langgraph-typescript) | FlairClient | Drop-in `BaseStore` |
| **OpenClaw** | [`openclaw-flair`](#openclaw) | Ed25519 | Native plugin + context engine |
| **n8n** | [`n8n-nodes-flair`](#n8n) | FlairApi credential | Three nodes (chat memory, search, store) |
| **Hermes Agent** | [`hermes-flair`](#hermes-agent) | Ed25519 | Python `MemoryProvider` |
| **Pi agent** | [`pi-flair`](#pi-agent) | Ed25519 | Native pi extension (pi has no MCP support); `flair init --client pi` wires it, `flair doctor` checks it |
| **Google ADK** (Python) | [`adk-flair`](../packages/adk-flair/README.md) | Ed25519 | `BaseMemoryService`; see [hosted auth](#hosted-flair-auth--your-agent-got-a-404) if you just got a 404 |
| **Google ADK** (JS/TS) | [`@tpsdev-ai/adk-flair`](../packages/adk-flair-js/README.md) | Ed25519 | Same identity model as the Python package |

Don't see your harness? If it speaks **MCP** — Flair already works with `flair-mcp`. If it has a **custom memory protocol** like LangGraph's `BaseStore` or CrewAI's `RAGStorage`, an adapter is a ~200-line package; [open an issue](https://github.com/tpsdev-ai/flair/issues) or [send a PR](https://github.com/tpsdev-ai/flair).

**Already running on Harper?** Every surface above reaches Flair over HTTP. If your application is itself a Harper app, you can skip the network entirely — load Flair as a component of the same instance and call its resources in-process. See [embedding-in-a-harper-app.md](embedding-in-a-harper-app.md), which also covers the table-vs-resource distinction that decides whether your memories are scoped.

**Adjacent: memory bridges** — for moving memories between Flair and another memory product. Five bridges ship today (Mem0, ChatGPT exports, claude-project files, agentic-stack, markdown); see [bridges.md](bridges.md). Bridges are import/export plumbing, not live orchestrator integrations.

---

## Hosted Flair auth — your agent got a 404

Written for the person whose adapter just got a 404 against a hosted Flair (Harper Fabric or any non-localhost URL). Laptop `flair init` on `127.0.0.1:19926` is a different machine from the one signing the request.

The protocol lives in [auth.md](auth.md). Key lifecycle lives in [secrets-and-keys.md](secrets-and-keys.md). Fabric registration (including the ops-port trap) lives in [quickstart-fabric.md](quickstart-fabric.md). This section is only the identity check.

### Identity is three things that must match

Ed25519 agent auth is not a password. The server accepts a request only when all three line up:

1. **Agent id** — `FLAIR_AGENT_ID`. This is the string inside the signature.
2. **Keyfile on the machine that signs** — `FLAIR_KEYFILE` (adk-flair / adk-flair-js) or `FLAIR_KEY_PATH` (flair-mcp, Hermes, pi). The private key never leaves that host. `flair agent add` writes `~/.flair/keys/<id>.key`.
3. **Server-side `Agent` row on the instance at `FLAIR_URL`** whose `publicKey` matches that keyfile. Registration is per instance. A key minted against localhost is not registered on Fabric until you run `flair agent add <id> --target` at that URL.

The signed payload is `agentId:timestamp:nonce:METHOD:/path` (30-second replay window).

Do not "fix" a 401 or 404 by pasting the Harper admin password into the agent's standing environment. Admin Basic auth is for registration, once. The first signed call against an unregistered id is **401 `unknown_agent`** — that is fail-closed working as designed.

### The three failure shapes

| Shape | What is true | What you see | What to do |
|---|---|---|---|
| **Record missing** | No `Agent` row for this id on **this** instance | `401 {"error":"unknown_agent"}` on every signed route | Register against the hosted URL: `flair agent add <id> --target "$FLAIR_URL" --ops-target <ops-url> --admin-pass-file <path>`. Fabric ops is not `data-port − 1` — see [quickstart-fabric.md](quickstart-fabric.md). |
| **Key mismatch** | The id exists; the public key on the server is not the one in your keyfile | `401 {"error":"invalid_signature"}` | Same id, wrong key — copied from another host, rotated on one side only, or the env pointing at a different agent's file. Point the env at the key that matches **this** instance, or re-seed the hosted `Agent` row from the key on this machine: `flair agent add <id> --target "$FLAIR_URL" --ops-target <ops-url> --admin-pass-file <path>` (reuses the local keyfile). `flair agent rotate-key` is localhost-only. Restart the adapter so it reloads the key. |
| **Config wrong** | Identity may be fine; you are not talking to the Flair you think | Timeouts, connection errors, or **404 from Harper's catch-all** | `FLAIR_URL` must be the origin the **signing process** can open (cloud-agent localhost is the VM, not your laptop). adk-flair also needs `FLAIR_ALLOW_REMOTE_URL=1` and a raised `FLAIR_HTTP_TIMEOUT` (defaults are localhost fail-fast). A `FLAIR_URL` with a path prefix sends every request to a route that does not exist. `/Health` can be 200 while `/Memory` is still 404 if the Flair app is not loaded yet. |

Clock skew is a fourth, rarer 401: `timestamp_out_of_window`.

`flair agent list` talks to **localhost**. It cannot tell you whether the hosted instance has your Agent row. The discriminator is the 401 body on a signed request.

### 404 on by-id routes is not an existence signal

`GET /Memory/{id}`, `PUT /Memory/{id}`, and the adapter/MCP wrappers (`memory_get`, a by-id update) return **404** both when the id is absent **and** when the record exists but your principal may not see it (another agent's `private` memory, or outside your read scope). Same status, same body shape. That is fail-closed ownership ([flair#1264](https://github.com/tpsdev-ai/flair/issues/1264)) — a 403 would confirm the id exists and can name the owner.

**Do not treat that 404 as "the record is missing, so create it" or "Harper rejected the verb."** Creates go to `POST /Memory/` (id in the body). A by-id 404 after a write usually means you are not the owner the server thinks you are — go back to the three shapes above — not that you should switch PUT for POST.

A verified agent that is not allowed the row gets 404, never 403. Anonymous by-id reads are denied at the gate.

### Per-adapter env

| Adapter | URL | Agent id | Keyfile | Hosted extras |
|---|---|---|---|---|
| **adk-flair** / **adk-flair-js** | `FLAIR_URL` | `FLAIR_AGENT_ID` | `FLAIR_KEYFILE` | `FLAIR_ALLOW_REMOTE_URL=1`, `FLAIR_HTTP_TIMEOUT` — [adk-flair README](../packages/adk-flair/README.md#hosted-flair) |
| **flair-mcp** / Cursor plugin | `FLAIR_URL` | `FLAIR_AGENT_ID` | `FLAIR_KEY_PATH` (optional; auto-resolved) | Key must be on the **npx host** |
| **Hermes / pi / LangGraph** | `FLAIR_URL` | `FLAIR_AGENT_ID` | `FLAIR_KEY_PATH` or client `keyPath` | Same Ed25519 model |

n8n still uses Harper admin Basic auth — it is not this path. See [n8n.md](n8n.md#security).

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

**Antigravity CLI** (`agy`) (`~/.gemini/config/mcp_config.json` — Antigravity's own MCP config, separate from Gemini CLI's `settings.json`): same shape as Cursor. Newly added; the config path follows Antigravity's documentation, but Flair has not yet verified end-to-end pickup by a live `agy` — after wiring, restart Antigravity and confirm the flair tools appear.

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

[`@tpsdev-ai/pi-flair`](https://www.npmjs.com/package/@tpsdev-ai/pi-flair) is the **native pi extension** for the [Pi coding agent](https://github.com/mariozechner/pi-coding-agent) — pi has no MCP client support, so this is a first-party plugin, not an MCP bridge. Memory + identity (`memory_search`, `memory_store`, `bootstrap`) for the pi runtime.

Wire it (either form is equivalent):

```bash
flair init --client pi        # writes a pinned "packages" entry into ~/.pi/agent/settings.json
# or
pi install npm:@tpsdev-ai/pi-flair
```

Which produces:

```json
{
  "packages": ["npm:@tpsdev-ai/pi-flair@<version>"]
}
```

**Known trap:** the `extensions` settings key takes local file paths only — an `npm:` spec there is *silently ignored* by pi, so the tools never register ([#1346](https://github.com/tpsdev-ai/flair/issues/1346)). Package sources belong under `packages`. `flair doctor` detects pi, verifies the wiring, calls this exact misconfiguration out, and `flair doctor --fix` moves the entry.

pi settings carry no per-package env, so identity comes from the environment that launches pi:

```bash
export FLAIR_AGENT_ID=my-agent   # per host/purpose
pi
```

Full details (tools, env reference, auto-recall/auto-capture flags, security notes): [`packages/pi-flair/README.md`](../packages/pi-flair/README.md).

---

## Don't see your harness?

If it speaks MCP, you're already covered — every MCP client works through `flair-mcp` (the section above lists 6 we've explicitly tested).

If it has a custom memory protocol, the adapter pattern is small (~200 lines). LangGraph and Hermes are the reference implementations. **Adapters we'd love to see:**

- LangGraph Python (mirror of our TS adapter)
- CrewAI (Python `BaseRAGStorage` protocol)
- AG2 / AutoGen (Python)
- Mastra (TS, denser thread model)

[Open an issue](https://github.com/tpsdev-ai/flair/issues) describing the harness and we'll triage. PRs welcome — see [`packages/langgraph-flair`](../packages/langgraph-flair) as the smallest-shape reference.

---

## See also

- [Quickstart](quickstart.md) — `flair init` to working memory on a laptop
- [Fabric Quickstart](quickstart-fabric.md) — `flair deploy` to a reachable Harper Fabric URL
- [Hosted Flair auth](#hosted-flair-auth--your-agent-got-a-404) — Ed25519 identity, the three 401/404 shapes, why a by-id 404 is not an existence signal
- [Embedding in a Harper app](embedding-in-a-harper-app.md) — run Flair as a component of your own Harper instance and call it in-process
- [Memory bridges](bridges.md) — import/export Flair ↔ Mem0, ChatGPT, claude-project, markdown, agentic-stack (five bridges shipped)
- [Federation](federation.md) — pair instances peer-to-peer for cross-machine sync
- [Supply-chain policy](supply-chain-policy.md) — what we do to keep this list of integrations safe
- [The team](the-team.md) — the multi-agent rig that builds Flair, dogfooded on every harness above
