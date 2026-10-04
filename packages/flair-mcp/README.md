# @tpsdev-ai/flair-mcp

MCP server for [Flair](https://tps.dev/#flair) — persistent memory for Claude Code, Cursor, and any MCP client.

## Quick Start

### Claude Code

```bash
# Add to your project's .mcp.json
cat > .mcp.json << 'EOF'
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
EOF
```

`npx -y @tpsdev-ai/flair-mcp` fetches and runs the server on demand — no global install needed. (`flair init --agent <id>` attempts to wire detected clients when wiring is enabled; see below.)

### Prerequisites

You need a running Flair instance. The one-command front door:

```bash
npm install -g @tpsdev-ai/flair
flair init --agent my-project   # installs Harper, creates the agent, wires MCP clients
```

## Tools

Once configured, Claude Code (or any MCP client) gets these tools:

| Tool | Description |
|------|-------------|
| `memory_search` | Semantic search across memories. Understands "what happened today". |
| `memory_store` | Save a memory with type (lesson/decision/fact) and durability. Optional `usedMemoryIds` cites memories that informed the write. |
| `memory_get` | Retrieve a specific memory by ID. |
| `memory_delete` | Delete a memory. |
| `skill_store` | Write a skill (trigger + procedure) as a skill-tagged memory. |
| `skill_search` | Find skills that apply to a task. Returns a catalog, not the procedure. |
| `skill_get` | Retrieve the full skill by ID (disclosure after `skill_search`). |
| `bootstrap` | Cold-start context — soul + recent memories in one call. |
| `soul_set` | Soul writes require verified administrator Basic credentials; Ed25519 agent requests are refused. Operators should use the REST API or CLI. |
| `soul_get` | Get a personality or project context entry. |
| `record_usage` | Report that recalled memories were actually used (drives `usageCount`). |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `FLAIR_AGENT_ID` | *(required)* | Agent identity for memory scoping |
| `FLAIR_URL` | `http://localhost:19926` | Flair server URL |
| `FLAIR_KEY_PATH` | auto-resolved | Path to Ed25519 private key |
| `FLAIR_ADMIN_USER` | *(optional)* | Admin username for Basic auth (standalone mode) |
| `FLAIR_ADMIN_PASSWORD` | *(optional)* | Admin password for Basic auth (standalone mode) |

## How It Works

```
Claude Code ↔ stdio ↔ flair-mcp ↔ HTTP ↔ Flair (Harper)
```

The MCP server is a thin wrapper around `@tpsdev-ai/flair-client`. All memory is stored in the Flair instance selected by `FLAIR_URL` (defaulting to localhost). Requests are signed with the agent's Ed25519 key whenever one resolves. Only when no key resolves, and both `FLAIR_ADMIN_USER` and `FLAIR_ADMIN_PASSWORD` are set, does the client send admin Basic auth; a key that cannot be parsed is an error, and a rejected signature is not retried with Basic. The MCP client connects to FLAIR_URL; a paired local instance may separately federate eligible memories.

## Remote Flair

Point to a remote Flair instance:

```json
{
  "mcpServers": {
    "flair": {
      "command": "npx",
      "args": ["-y", "@tpsdev-ai/flair-mcp"],
      "env": {
        "FLAIR_AGENT_ID": "my-project",
        "FLAIR_URL": "https://your-server:19926"
      }
    }
  }
}
```

The client REFUSES to send admin Basic credentials over plain HTTP to a non-loopback host (the credentials would travel in a request header): use an HTTPS `FLAIR_URL`, or an Ed25519 key, for a remote instance. Copy your key from the server: `scp server:~/.flair/keys/my-project.key ~/.flair/keys/`

## License

[Apache 2.0](../../LICENSE)
