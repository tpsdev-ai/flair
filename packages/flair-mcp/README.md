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
      "args": ["@tpsdev-ai/flair-mcp"],
      "env": {
        "FLAIR_AGENT_ID": "my-project"
      }
    }
  }
}
EOF
```

Or install globally and configure once in `~/.claude/settings.json`.

### Prerequisites

You need a running Flair instance:

```bash
npm install -g @tpsdev-ai/flair
flair init
flair agent add my-project
```

## Tools

Once configured, Claude Code (or any MCP client) gets these tools:

| Tool | Description |
|------|-------------|
| `memory_search` | Semantic search across memories. Understands "what happened today". |
| `memory_store` | Save a memory with type (lesson/decision/fact) and durability. |
| `memory_get` | Retrieve a specific memory by ID. |
| `memory_delete` | Delete a memory. |
| `bootstrap` | Cold-start context — soul + recent memories in one call. |
| `soul_set` | Set personality or project context (included in every bootstrap). |
| `soul_get` | Get a personality or project context entry. |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `FLAIR_AGENT_ID` | *(required)* | Agent identity for memory scoping |
| `FLAIR_URL` | `http://localhost:9926` | Flair server URL |
| `FLAIR_KEY_PATH` | auto-resolved | Path to Ed25519 private key |

## How It Works

```
Claude Code ↔ stdio ↔ flair-mcp ↔ HTTP ↔ Flair (Harper)
```

The MCP server is a thin wrapper around `@tpsdev-ai/flair-client`. All memory is stored in your local Flair instance with Ed25519 authentication. Nothing leaves your machine unless you point `FLAIR_URL` at a remote server.

## Remote Flair

Point to a remote Flair instance:

```json
{
  "mcpServers": {
    "flair": {
      "command": "npx",
      "args": ["@tpsdev-ai/flair-mcp"],
      "env": {
        "FLAIR_AGENT_ID": "my-project",
        "FLAIR_URL": "http://your-server:9926"
      }
    }
  }
}
```

Copy your key from the server: `scp server:~/.flair/keys/my-project.key ~/.flair/keys/`

## License

[Apache 2.0](../../LICENSE)
