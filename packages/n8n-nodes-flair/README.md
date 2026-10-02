# @tpsdev-ai/n8n-nodes-flair

n8n community node — use [Flair](https://github.com/tpsdev-ai/flair) as your AI Agent's memory backend.

## Nodes

- **Flair Chat Memory** — n8n AI Agent Memory port. Stores chat history in Flair, replayable across runs and readable from Claude Code, OpenClaw, and any other Flair client. LangChain `BufferWindowMemory` under the hood.
- **Flair Search** — n8n AI Agent Tool port. Two operations:
  - *Semantic Search* — finds memories ranked by similarity to a natural-language query.
  - *Get By Subject* — lists memories filtered by subject.
  - *Get By Tag* — not yet an operation in the `FlairSearch` node. The `memory.list` client supports the `tags` filter.

## Installation

```sh
npm install @tpsdev-ai/n8n-nodes-flair
```

Then restart your n8n instance. The Flair API credential will appear under **Credentials** → **New** → **Flair API**.

Full setup walkthrough, subject/sessionId patterns, and security guidance are in [`docs/n8n.md`](https://github.com/tpsdev-ai/flair/blob/main/docs/n8n.md) in the Flair repo.

## Credential setup

1. **Base URL** — your Flair instance, e.g. `http://localhost:19926`
2. **Agent ID** — the identity that signs every request and owns the memories written from this n8n workspace. Workflows that share an Agent ID share memory ownership.
3. **Agent Private Key** — that agent's Ed25519 private key, base64-encoded: `flair agent add <agent-id>` then `base64 < ~/.flair/keys/<agent-id>.key`. Every request is signed as that agent, so the workflow reaches that agent's memories and other agents' non-private memories — never their private ones. The key is a secret: it is never logged, echoed into node output or errors, or sent anywhere except as a signature.

The credential test signs a read as that agent, so you'll know the key and agent id are right when the test succeeds.

**Admin Password (deprecated)** — the v1 field. It authenticates as the Harper administrator, which grants read/write to the entire instance — including every other agent's private memories — instead of signing as the agent above. It is used only while Agent Private Key is empty, and every execution that uses it logs a warning. Prefer the agent key.

## License

Apache-2.0
