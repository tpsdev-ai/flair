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
      "allow": ["openclaw-flair"],
      "slots": {
        "memory": "openclaw-flair"
      },
      "entries": {
        "openclaw-flair": {
          "enabled": true,
          "hooks": {
              "allowPromptInjection": true
          },
          "config": {
            "url": "http://127.0.0.1:19926",
            "autoRecall": true,
            "autoCapture": false,
            "maxRecallResults": 5,
            "maxBootstrapTokens": 4000,
             "agentId": "my-agent"
          }
        }
      }
    }
}
```

`allowConversationAccess` is required to enable auto-capture (the plugin also reads it for a startup warning and status), so this example, with `autoCapture: false`, leaves it out.

An optional `agentId` in `config` is an **allow-list**: it restricts which agents may be served but never substitutes for the host's per-invocation identity, which comes from host context on every call.
### 5. Restart the gateway

```bash
openclaw gateway restart
```

## What the Plugin Provides

The Flair plugin adds these tools to your OpenClaw agent:

| Tool | Description |
|------|-------------|
| `memory_store` | Write a memory with optional type, durability, and tags |
| `memory_search` | Semantic search over stored memories |
| `memory_get` | Retrieve a specific memory by ID |

### Automatic Bootstrap

With `autoRecall` on (the default) and the host's `hooks.allowPromptInjection` enabled, the plugin handles `before_prompt_build`: it requests bootstrap context from Flair, up to `maxBootstrapTokens` and without passing a conversation topic, and returns it as `prependContext` when the context is non-empty. The context can include:
- Soul entries (persistent personality and project context)
- Recent memories (an adaptive window: 48 hours, widening to 7 and then 30 days when fewer than three are found)

Without `hooks.allowPromptInjection` the plugin contributes no context and logs `prompt context disabled: policy` at startup.

## Multi-Agent

Each OpenClaw agent writes with its `agentId` as a field (tags are optional); reads use owner plus visibility. A verified agent can read all its own records (private included) and other agents' non-private records on the instance; grants do not expand that read scope.

```bash
flair agent add research-agent
flair agent add coding-agent
flair agent add review-agent
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

The plugin finds Ed25519 keys for the host-provided agent identity: `keyPath` from config is only valid with a sole allowed agent (`agentId` set); otherwise the client resolves via `FLAIR_KEY_DIR` env var, then `~/.flair/keys/<agent-id>.key`, then `~/.tps/secrets/flair/<agent-id>-priv.key`. For each resolved home, `.flair` then the legacy path are checked in order before the next home.

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
