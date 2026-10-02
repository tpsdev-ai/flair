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
2. **Agent ID** — the memory owner and, with Agent Private Key selected, signing identity. Workflows that share an Agent ID share memory ownership.
3. **Agent Private Key** — that agent's Ed25519 private key, base64-encoded: `flair agent add <agent-id>` then `base64 < ~/.flair/keys/<agent-id>.key`. With Agent Private Key selected, requests sign as Agent ID. Ordinary agents read their own and other agents' non-private memories; administrator-role agents have broader authority.

The credential test reads `/Memory` with the selected auth mode and reports that mode on success.

**Admin Password (deprecated)** — used only with Agent Private Key empty. Requests use Harper administrator Basic authentication, including access to other agents' private memories, and each node execution warns.

## License

Apache-2.0
