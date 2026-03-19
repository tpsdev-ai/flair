# @tpsdev-ai/flair-client

Lightweight client for [Flair](https://tps.dev/#flair) — identity, memory, and soul for AI agents.

Zero heavy dependencies. Just Ed25519 auth + HTTP. Works with any Flair instance, local or remote.

## Install

```bash
npm install @tpsdev-ai/flair-client
```

## Quick Start

```ts
import { FlairClient } from '@tpsdev-ai/flair-client'

const flair = new FlairClient({
  url: 'http://localhost:9926',   // or remote: https://flair.example.com
  agentId: 'my-agent',
  // keyPath auto-resolved from ~/.flair/keys/my-agent.key
})

// Write a memory
await flair.memory.write('Harper v5 sandbox blocks bare imports')

// Search by meaning
const results = await flair.memory.search('native module loading issues')
// → [{ content: 'Harper v5 sandbox blocks bare imports', score: 0.72, ... }]

// Cold-start bootstrap (soul + recent memories)
const ctx = await flair.bootstrap({ maxTokens: 4000 })
console.log(ctx.context) // formatted context block
```

## Memory API

```ts
// Write with options
await flair.memory.write('deploy procedure changed', {
  type: 'decision',
  durability: 'persistent',
  tags: ['ops', 'deploy'],
})

// Get by ID
const mem = await flair.memory.get('my-agent-1234567890')

// List recent
const recent = await flair.memory.list({ limit: 10 })

// Delete
await flair.memory.delete('my-agent-1234567890')
```

## Soul API

```ts
// Set personality/values
await flair.soul.set('role', 'Security reviewer, meticulous and skeptical')
await flair.soul.set('tone', 'Direct, technical, no fluff')

// Read
const role = await flair.soul.get('role')

// List all
const entries = await flair.soul.list()
```

## Auth

Flair uses Ed25519 signatures. The client auto-discovers your key from:

1. `keyPath` option (explicit)
2. `FLAIR_KEY_DIR` env + `{agentId}.key`
3. `~/.flair/keys/{agentId}.key`
4. `~/.tps/secrets/flair/{agentId}-priv.key`

Generate a key with the Flair CLI:

```bash
npm install -g @tpsdev-ai/flair
flair init && flair agent add my-agent
```

## Use with Claude Code

Add to your `CLAUDE.md`:

```markdown
## Memory (Flair)
You have persistent memory. Use it.
- Bootstrap on start: `npx @tpsdev-ai/flair-client bootstrap --agent $AGENT_ID`
- Store lessons: `npx @tpsdev-ai/flair-client write --agent $AGENT_ID "what you learned"`
- Search: `npx @tpsdev-ai/flair-client search --agent $AGENT_ID "your query"`
```

Or use the Flair CLI directly:

```markdown
## Memory (Flair)
- `flair memory search --agent my-agent -q "your query"`
- `flair memory add --agent my-agent --content "what to remember"`
- `flair memory list --agent my-agent --limit 20`
```

## Configuration

| Option | Env | Default | Description |
|--------|-----|---------|-------------|
| `url` | `FLAIR_URL` | `http://localhost:9926` | Flair server URL |
| `agentId` | `FLAIR_AGENT_ID` | — | Agent identifier |
| `keyPath` | `FLAIR_KEY_DIR` | auto-resolved | Private key path |
| `timeoutMs` | — | `10000` | Request timeout |

## License

[Apache 2.0](../../LICENSE)
