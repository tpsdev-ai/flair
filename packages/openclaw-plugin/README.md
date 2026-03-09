# @tps/memory-flair

OpenClaw memory plugin backed by [Flair](https://github.com/tpsdev-ai/flair) (Harper v5).

Replaces `MEMORY.md` and built-in file-based memory with a semantic vector store — Ed25519-authenticated, multi-agent isolated, and self-hostable on Harper Fabric.

## What it does

| Tool | Backend |
|------|---------|
| `memory_recall` | `POST /SemanticSearch` — HNSW semantic search |
| `memory_store` | `PUT /Memory/<id>` — write with embeddings |
| `memory_get` | `GET /Memory/<id>` — fetch by id |
| `before_agent_start` | `POST /BootstrapMemories` — inject context |
| `agent_end` | Auto-capture from conversation |

## Requirements

- [Flair](https://github.com/tpsdev-ai/flair) running locally or on Harper Fabric
- An agent registered in Flair (via `tps roster add` or `POST /Agent/`)
- An Ed25519 private key at `~/.tps/secrets/flair/<agentId>-priv.key`

## Install

```bash
openclaw plugins install @tps/memory-flair
```

Or manually copy `packages/openclaw-plugin/` into `~/.openclaw/extensions/memory-flair/`.

## OpenClaw Config

```json5
{
  "plugins": {
    "slots": { "memory": "memory-flair" },
    "entries": {
      "memory-flair": {
        "enabled": true,
        "config": {
          "url": "http://localhost:9926",
          "agentId": "flint",
          "keyPath": "~/.tps/secrets/flair/flint-priv.key",
          "autoRecall": true,
          "autoCapture": true,
          "maxRecallResults": 5,
          "maxBootstrapTokens": 4000
        }
      }
    }
  }
}
```

## Deploying Flair to Harper Fabric

Harper Fabric hosts Flair as a public multi-agent memory instance.

### 1. Get a Fabric cluster

Sign up at [harperdb.io](https://harperdb.io) (free tier available) or self-host Harper v5.

### 2. Deploy the Flair app

```bash
git clone https://github.com/tpsdev-ai/flair
cd flair

# Set your Fabric host and credentials
export HARPER_HOST=https://your-cluster.harperdbcloud.com
export HARPER_ADMIN=admin
export HARPER_PASS=YourAdminPassword

# Deploy
bun run deploy
```

The deploy script packages `resources/`, `schemas/`, and `config.yaml` and pushes to Harper via the operations API.

### 3. Register your agent

```bash
# From your TPS workspace
tps roster add <agentId> --flair-url https://your-cluster.harperdbcloud.com
```

This generates an Ed25519 keypair, registers the agent in Flair, and writes the private key to `~/.tps/secrets/flair/<agentId>-priv.key`.

### 4. Point the plugin at your Fabric instance

Update `url` in the plugin config:

```json
"url": "https://your-cluster.harperdbcloud.com"
```

## Auth

Every request uses TPS-Ed25519 authentication:

```
Authorization: TPS-Ed25519 <agentId>:<timestamp>:<nonce>:<base64-signature>
```

The signature covers `<agentId>:<timestamp>:<nonce>:<method>:<path>` with a 30-second replay window. If the key is missing or invalid, requests are sent without auth (Flair will reject them with 401, and tools degrade gracefully).

## Fallback Behavior

If Flair is unreachable:
- `memory_recall` → returns empty results + logs warning
- `memory_store` → returns error message (does not crash the agent)
- Bootstrap (`before_agent_start`) → skips context injection silently
- `memory_get` → returns "not found"

## Durability Levels

| Level | Description |
|-------|-------------|
| `permanent` | Inviolable — requires admin CLI to delete. Agents cannot write permanent (silently downgraded to `persistent`). |
| `persistent` | Key decisions, long-term preferences |
| `standard` | Default — session-to-session context |
| `ephemeral` | Auto-expires after TTL |

## Multi-Agent Isolation

Each agent can only access memories where `agentId` matches their authenticated identity. `visibility:office` memories are readable by all agents in the same office. Cross-agent sharing requires `MemoryGrant` (admin operation).

## Development

```bash
cd packages/openclaw-plugin
bun install
bun run typecheck
bun test
```
