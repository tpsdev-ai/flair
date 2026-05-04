# Worked-example workflows

Two example workflows are planned for this directory:

- **`chat-memory-demo.json`** — Webhook → AI Agent (Claude + Flair Chat Memory) → Respond. Demonstrates the conversation-buffer use case; running twice with the same input shows memory replay.
- **`knowledge-search-demo.json`** — Schedule trigger → AI Agent (Claude + Flair Chat Memory + Flair Search as Tool) → action. Demonstrates the structured-knowledge-search use case.

Both are deferred to a follow-up release so the JSON can be authored *inside a real n8n instance* and round-tripped via Workflows → Export, rather than hand-written and untested. n8n's exported workflow JSON has many fields whose semantics aren't fully documented; shipping examples that don't import cleanly is worse than no examples.

In the interim, the [docs/n8n.md](https://github.com/tpsdev-ai/flair/blob/main/docs/n8n.md) walkthrough describes the wiring step-by-step — if you follow it, you'll have a working chat-memory workflow without an example file.
