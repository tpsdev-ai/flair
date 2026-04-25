# Flair via MCP — Claude Code, Gemini CLI, OpenAI Codex CLI

Flair ships an MCP server (`@tpsdev-ai/flair-mcp`) that any MCP-compatible client can use as its persistent memory + identity layer. One server, three (and counting) integrations. Switch between agent CLIs without losing your agent's memory.

This page is the install + config snippet for each of the three major CLIs. The bootstrap is the same:

1. Install Flair and create an agent identity (one-time, ~2 min).
2. Add the MCP server to your CLI of choice (1 command or 1 file).
3. Verify the agent can call `memory_search` / `memory_store`.

If you've never set up Flair before, do step 1 first. If Flair is already running and you have an agent ID, jump to your CLI section.

---

## Step 1 — Install Flair (do once)

```bash
# Install Flair globally
npm install -g @tpsdev-ai/flair

# Initialize the local Harper-backed server
flair init

# Provision an agent identity. Pick a name — typically per-project, per-purpose,
# or "me" if you want one durable identity across everything.
flair agent add my-project
# → writes ~/.flair/keys/my-project.key (Ed25519 PKCS8) and registers the agent

# Sanity check
flair status
```

Flair runs as a local server at `http://127.0.0.1:9926` by default. The MCP server connects to it on demand via Ed25519-signed requests; nothing leaves your machine unless you explicitly route to a remote Flair instance.

---

## Step 2 — Wire the MCP server into your CLI

Pick whichever you use. The MCP server is the same package; only the config syntax differs.

### Claude Code

The canonical approach is the `claude mcp add` CLI (writes to `~/.claude/mcp.json`):

```bash
claude mcp add flair --scope user \
  -e FLAIR_AGENT_ID=my-project \
  -- npx -y @tpsdev-ai/flair-mcp
```

Verify:

```bash
claude mcp list
# → flair (stdio, npx -y @tpsdev-ai/flair-mcp)
```

Or, if you prefer the project-scoped `.mcp.json` checked into your repo:

```json
{
  "mcpServers": {
    "flair": {
      "command": "npx",
      "args": ["-y", "@tpsdev-ai/flair-mcp"],
      "env": {
        "FLAIR_AGENT_ID": "my-project"
      }
    }
  }
}
```

### Gemini CLI

Edit `~/.gemini/settings.json` (create it if absent):

```json
{
  "mcpServers": {
    "flair": {
      "command": "npx",
      "args": ["-y", "@tpsdev-ai/flair-mcp"],
      "env": {
        "FLAIR_AGENT_ID": "my-project"
      }
    }
  }
}
```

Restart your Gemini CLI session for the config to take effect. Then in chat:

```
> @flair memory_search "what did we decide about auth last week?"
```

### OpenAI Codex CLI

Edit `~/.codex/config.toml` (create it if absent):

```toml
[mcp_servers.flair]
command = "npx"
args = ["-y", "@tpsdev-ai/flair-mcp"]

[mcp_servers.flair.env]
FLAIR_AGENT_ID = "my-project"
```

For project-scoped trust (per Codex's MCP guide), the same block in `.codex/config.toml` at the project root.

Restart your Codex CLI session and the `flair_*` tools become available to the agent.

---

## Step 3 — Verify

In any of the three CLIs, ask the agent to do this:

> Use the bootstrap tool to load my Flair memory context, then store a memory that says "successful first MCP integration test."

If you see (a) the agent calling the `bootstrap` tool returning soul + recent memories, and (b) `memory_store` confirming a write — you're wired up. The memory now persists across CLI sessions AND across CLIs. Switch to a different CLI tomorrow and `memory_search "MCP integration test"` will find it.

---

## What the MCP server exposes

Seven tools, kept deliberately small:

| Tool | What it does |
|---|---|
| `memory_search` | Semantic search across your agent's memories |
| `memory_store` | Save a memory with type, durability, tags. Auto-dedups near-duplicates |
| `memory_get` | Fetch a specific memory by ID |
| `memory_delete` | Remove a memory |
| `bootstrap` | Get session-start context: soul + recent memories + predicted-relevant context |
| `soul_set` | Set a personality/project/standards entry — included in every bootstrap |
| `soul_get` | Get a soul entry |

All scoped per-agent (your `FLAIR_AGENT_ID`). Cross-agent reads are refused by Flair's server, not by client convention — different agents on the same Flair instance can't see each other's memories.

---

## Configuration reference

| Env var | Default | Notes |
|---|---|---|
| `FLAIR_AGENT_ID` | (none — required) | Must match `flair agent add <id>` |
| `FLAIR_URL` | `http://127.0.0.1:9926` | Override for remote Flair instances |
| `FLAIR_KEY_PATH` | `~/.flair/keys/<agent>.key` | Ed25519 PKCS8 key — created by `flair agent add` |

The MCP server has no client-side flags beyond these env vars; everything else (timeouts, dedup thresholds, error classification) is opinionated defaults from the underlying [`@tpsdev-ai/flair-client`](../packages/flair-client) package.

---

## What about Hermes (Nous Research)?

Hermes uses its own Python-native `MemoryProvider` ABC instead of MCP. It has its own Flair integration in [`plugins/hermes-flair/`](../plugins/hermes-flair). Same backend, same agent isolation, different plug shape.

Future MCP-capable agent CLIs (and there are more landing every month) will work out of the box with the MCP server above — no per-framework adapter required from us.

---

## Troubleshooting

**"FLAIR_AGENT_ID is required" on startup.** Set it in the MCP server's `env` block (per snippets above). The CLI's own env doesn't propagate to the spawned MCP subprocess unless declared.

**"connection_error: could not reach Flair at http://127.0.0.1:9926".** The Flair server isn't running. Run `flair status` to check; `flair start` to bring it up.

**"auth_error: …" on every call.** The agent identity doesn't match a registered key. Re-run `flair agent add <id>` (idempotent on re-add — won't lose existing memories).

**Tool calls succeed but the agent doesn't see results in subsequent turns.** Check that the CLI is actually invoking `bootstrap` at session start — most CLIs need an explicit prompt nudge ("call the bootstrap tool now") on first use. Subsequent turns should pick up automatically once the CLI sees the schema.

For deeper issues see [`troubleshooting.md`](troubleshooting.md) and the [`@tpsdev-ai/flair-mcp` repo](https://github.com/tpsdev-ai/flair/tree/main/packages/flair-mcp).
