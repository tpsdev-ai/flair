# @tpsdev-ai/n8n-nodes-flair

n8n community node — use [Flair](https://github.com/tpsdev-ai/flair) as your AI Agent's memory backend.

## Status

**0.1.0 — scaffold.** Credential type only; nodes ship in subsequent releases:

- `FlairChatMemory` (Memory port, conversation buffer) — coming in 0.2.0
- `FlairSearch` (Tool port, knowledge search) — coming in 0.3.0

See [spec](https://github.com/tpsdev-ai/flair/blob/main/specs/N8N-NODE-q3qf.md) for the implementation plan.

## Installation

```sh
npm install @tpsdev-ai/n8n-nodes-flair
```

Then restart your n8n instance. The Flair API credential will appear under **Credentials** → **New** → **Flair API**.

## Credential setup

1. **Base URL** — your Flair instance, e.g. `http://localhost:9926`
2. **Agent ID** — the logical identity that will own memories written from this n8n workspace. Workflows that share an Agent ID share memory ownership.
3. **Admin Token** — your Flair admin token. **This grants read/write access to the entire instance.** For production with untrusted workflow inputs, wait for Ed25519 per-agent auth (post-1.0).

The credential test hits `/Health` — you'll know it works when the test succeeds.

## License

Apache-2.0
