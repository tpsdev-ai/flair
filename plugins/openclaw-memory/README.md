# @tps/openclaw-flair

OpenClaw memory plugin for Flair — agent identity and semantic memory. Replaces the built-in `MEMORY.md` / `memory-lancedb` system with [Flair](https://github.com/tpsdev-ai/flair) as the single source of truth for agent memory.

Uses Flair's native Harper vector embeddings — no OpenAI API key required.

## Features

- **Semantic search** via `memory_recall` → Flair's HNSW vector index
- **Persistent storage** via `memory_store` → Ed25519-authenticated writes
- **Memory retrieval** via `memory_get` → fetch by ID
- **Auto-bootstrap** — injects relevant memories into context at session start
- **Auto-capture** — automatically stores important information from conversations
- **Multi-agent** — `agentId: "auto"` resolves per-session for shared gateways
- **Durability levels** — permanent, persistent, standard, ephemeral
- **Memory versioning** — `supersedes` field creates version chains

## Prerequisites

- A running [Flair](https://github.com/tpsdev-ai/flair) instance (Harper v5+)
- An agent record in Flair with an Ed25519 public key
- The corresponding private key at `~/.tps/secrets/flair/<agentId>-priv.key`

## Installation

```bash
# From npm (when published)
openclaw plugin install @tps/openclaw-flair

# From source
cd plugins/openclaw-memory
npm install
```

## Configuration

In your OpenClaw config (`openclaw.json`):

```json
{
  "plugins": {
    "allow": ["memory-flair"],
    "slots": {
      "memory": "memory-flair"
    },
    "entries": {
      "memory-flair": {
        "enabled": true,
        "config": {
          "url": "http://localhost:9926",
          "agentId": "auto",
          "autoCapture": true,
          "autoRecall": true,
          "maxRecallResults": 5,
          "maxBootstrapTokens": 4000
        }
      }
    }
  }
}
```

### Config Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `url` | string | `http://127.0.0.1:9926` | Flair server URL |
| `agentId` | string | *required* | Agent ID for memory namespacing. Use `"auto"` for multi-agent gateways. |
| `keyPath` | string | auto-resolved | Path to Ed25519 private key |
| `autoCapture` | boolean | `true` | Auto-capture important info from conversations |
| `autoRecall` | boolean | `true` | Inject relevant memories at session start |
| `maxRecallResults` | number | `5` | Max results for `memory_recall` |
| `maxBootstrapTokens` | number | `4000` | Max tokens for bootstrap context injection |

## Auth

Uses TPS Ed25519 signatures. The plugin looks for private keys at:
1. `keyPath` from config (if set)
2. `~/.tps/secrets/flair/<agentId>-priv.key`
3. `~/.tps/secrets/<agentId>-flair.key`

## License

Apache-2.0
