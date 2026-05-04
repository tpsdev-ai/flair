# @tpsdev-ai/n8n-nodes-flair

n8n community node — use [Flair](https://github.com/tpsdev-ai/flair) as your AI Agent's memory backend.

## Nodes

- **Flair Chat Memory** — n8n AI Agent Memory port. Stores chat history in Flair, replayable across runs and readable from Claude Code, OpenClaw, and any other Flair client. LangChain `BufferWindowMemory` under the hood.
- **Flair Search** — n8n AI Agent Tool port. Two operations:
  - *Semantic Search* — finds memories ranked by similarity to a natural-language query.
  - *Get By Subject* — lists memories filtered by subject, ordered by recency.
  - *Get By Tag* — coming in a follow-up once `flair-client.memory.list` exposes a `tags` filter (tracked in the [spec](https://github.com/tpsdev-ai/flair/blob/main/specs/N8N-NODE-q3qf.md) §6).

## Installation

```sh
npm install @tpsdev-ai/n8n-nodes-flair
```

Then restart your n8n instance. The Flair API credential will appear under **Credentials** → **New** → **Flair API**.

Full setup walkthrough, subject/sessionId patterns, and security guidance are in [`docs/n8n.md`](https://github.com/tpsdev-ai/flair/blob/main/docs/n8n.md) in the Flair repo.

## Credential setup

1. **Base URL** — your Flair instance, e.g. `http://localhost:9926`
2. **Agent ID** — the logical identity that will own memories written from this n8n workspace. Workflows that share an Agent ID share memory ownership.
3. **Admin Password** — your Flair (Harper) admin password. **This grants read/write access to the entire instance.** For production with untrusted workflow inputs, wait for Ed25519 per-agent auth (planned).

The credential test hits `/Memory` (auth-required) — you'll know it works when the test succeeds.

## License

Apache-2.0
