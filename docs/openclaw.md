# Flair + OpenClaw

Give OpenClaw agents persistent memory and identity.

## Setup

### 1. Install Flair (if not already running)

```bash
npm install -g @tpsdev-ai/flair
flair init
```

### 2. Install the OpenClaw plugin

```bash
openclaw plugins install @tpsdev-ai/openclaw-flair
```

### 3. Create an agent identity

```bash
flair agent add my-agent
```

### 4. Configure the plugin

In your OpenClaw agent config, add the Flair plugin:

```json
{
  "plugins": {
    "@tpsdev-ai/openclaw-flair": {
      "agentId": "my-agent",
      "flairUrl": "http://localhost:19926"
    }
  }
}
```

Or set environment variables:

```bash
export FLAIR_AGENT_ID=my-agent
export FLAIR_URL=http://localhost:19926
```

### 5. Restart the gateway

```bash
openclaw gateway restart
```

## What the Plugin Provides

The Flair plugin adds these tools to your OpenClaw agent:

| Tool | Description |
|------|-------------|
| `memory_store` | Write a memory with optional type, durability, and tags |
| `memory_recall` | Semantic search over stored memories |
| `memory_get` | Retrieve a specific memory by ID |

### Automatic Bootstrap

On each new conversation, the plugin injects relevant context from Flair:
- Soul entries (persistent personality and project context)
- Recent memories (last 24h)
- Relevant memories (semantically matched to the conversation topic)

This happens automatically — no agent configuration needed beyond the plugin setup.

## Multi-Agent

Each OpenClaw agent gets its own isolated memory space:

```bash
flair agent add research-agent
flair agent add coding-agent
flair agent add review-agent
```

Agents can share memories via grants:

```bash
# Let review-agent read coding-agent's memories
flair grant coding-agent review-agent --scope read
```

## Soul (Personality)

Set persistent context that shapes how the agent behaves:

```bash
flair soul set --agent my-agent --key role \
  --value "Senior engineer focused on reliability. Ship quality over speed."

flair soul set --agent my-agent --key project \
  --value "E-commerce API. Node.js, PostgreSQL. 200K DAU."
```

Soul entries are included in every bootstrap — they're the agent's persistent identity.

## Key Resolution

The plugin resolves Ed25519 keys in this order:
1. `FLAIR_KEY_PATH` environment variable
2. `~/.flair/keys/<agent-id>.key`
3. `~/.tps/secrets/flair/<agent-id>-priv.key` (legacy TPS path)

## Troubleshooting

```bash
# Verify Flair is running
flair status

# Verify the agent exists
flair agent list

# Test memory roundtrip
flair memory add --agent my-agent --content "test memory"
flair search "test" --agent my-agent

# Check plugin is loaded
openclaw plugins list
```

If the plugin fails to load, check the gateway logs for Flair connection errors. Common issues:
- Wrong port (default changed to 19926 in v0.4.0)
- Agent not registered (`flair agent add <id>`)
- Key file missing (`~/.flair/keys/<agent-id>.key`)
