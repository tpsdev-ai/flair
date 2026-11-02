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

## Host compatibility

The declared LangChain peer ranges apply to two nodes:

- **Flair Search** needs `@langchain/core` `>=0.3.0 <2`; its schema passed the host's parser at the listed versions (table below).
- **Flair Chat Memory** needs `@langchain/classic` `>=1.0.0 <2`, tested with the packed node at the classic/core pairs below. Those classic releases require `@langchain/core` `^1.0.0` and `^1.3.0`, respectively.

Both tests pack the built node and install it with its host packages in a scratch prefix (no workspace overrides). The chat-memory test installs `@langchain/classic`, `@langchain/core` and `n8n-workflow` without `--legacy-peer-deps`, builds the memory through the node's `supplyData`, then runs `saveContext` and `loadMemoryVariables` against a stub Flair endpoint:

| `@langchain/classic` | `@langchain/core` | Save + load |
| --- | --- | --- |
| 1.0.0 | 1.0.0 | passed |
| 1.0.55 | 1.3.0 | passed |

The search test invokes the tool through the installed parser:

| `@langchain/core` | Valid `{ query }` | Non-string `query` |
| --- | --- | --- |
| 0.3.0 | accepted | rejected |
| 0.3.57 | accepted | rejected |
| 0.3.68 | accepted | rejected |
| 1.1.0 | accepted | rejected |
| 1.3.0 | accepted | rejected |

`@langchain/core` resolved by n8n releases measured: 1.119.0, 1.120.0, 1.121.0 and 1.122.0 resolve 0.3.68; 1.123.0 and 2.0.0 resolve 1.1.0; 2.16.0 resolves 1.1.34.

`FLAIR_N8N_HOST_CORE_VERSIONS` selects the version set when the test file is run directly; the shared unit lane strips `FLAIR_*` variables before it spawns a step, so the lane runs the default matrix.

## Credential setup

1. **Base URL** — your Flair instance, e.g. `http://localhost:19926`
2. **Agent ID** — the memory owner and, with Agent Private Key selected, signing identity. Workflows that share an Agent ID share memory ownership.
3. **Agent Private Key** — that agent's Ed25519 private key. Register a new agent with `flair agent add <agent-id>`, or use an existing agent's matching key; encode it with `base64 < ~/.flair/keys/<agent-id>.key`. With Agent Private Key selected, requests sign as Agent ID. Ordinary agents read their own and other agents' non-private memories; administrator-role agents have broader authority.

The credential test reads `/Memory` with the selected auth mode and reports that mode on success.

**Admin Password (deprecated)** — used only with Agent Private Key empty. Requests use Harper administrator Basic authentication, including access to other agents' private memories, and each node execution warns.

## License

Apache-2.0
