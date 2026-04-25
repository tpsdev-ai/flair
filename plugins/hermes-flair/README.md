# Flair memory plugin for Hermes

[Flair](https://github.com/tpsdev-ai/flair) is the open-source memory + identity layer for agents. This plugin makes Flair the durable memory backend for [Hermes](https://github.com/NousResearch/hermes-agent) agents — per-agent-scoped, Ed25519-signed, semantic-searchable.

## Why Flair underneath Hermes

Hermes already ships great built-in memory (MEMORY.md / USER.md). Flair extends it with:

- **Per-agent isolation enforced server-side.** Each Hermes agent identity gets its own Ed25519 keypair; cross-agent reads are refused at the API layer, not by client convention.
- **Agent-authored, no LLM-extraction-on-every-turn.** The agent decides what's worth remembering via the `flair_store` tool. No silent server-side fact extraction, no surprise persistence.
- **Self-hosted, no SaaS dependency.** Runs on a Mac Mini, a Raspberry Pi, or a cloud VM. Single Harper-backed binary.
- **Same backend for memory + identity.** Soul (who I am), agent registry (who else exists), and memories all live in one place — so the plugin can answer "who am I and what do I know" from a single source.
- **Portable across orchestrators.** The same Flair memory works under Hermes, Claude Code, Gemini CLI, OpenAI Codex CLI, and any other agent runtime that has a memory plugin slot. Switch orchestrators without losing your agent's state.

## Setup

```bash
# 1. Install Flair
npm i -g @tpsdev-ai/flair
flair init

# 2. Provision an Ed25519 identity for your Hermes agent
flair agent add hermes
# → writes ~/.flair/keys/hermes.key (PKCS8 base64)

# 3. Activate this plugin in Hermes
hermes memory enable flair
```

## Configuration

Provide via environment variables, or `$HERMES_HOME/flair.json`:

| Setting          | Env var          | Default                             | Notes                                           |
|------------------|------------------|-------------------------------------|-------------------------------------------------|
| Server URL       | `FLAIR_URL`      | `http://127.0.0.1:9926`              | Override for remote Flair deployments           |
| Agent ID         | `FLAIR_AGENT_ID` | `hermes`                            | Must match `flair agent add <id>`               |
| Private key path | `FLAIR_KEY_PATH` | `~/.flair/keys/<agent>.key`         | PKCS8 base64 Ed25519 key created above          |

Example `flair.json`:

```json
{
  "url": "http://127.0.0.1:9926",
  "agent_id": "hermes",
  "bootstrap_limit": 10,
  "recall_limit": 5
}
```

## What this plugin does

**At session start.** Pulls the agent's permanent + recent memories from Flair and injects them into the system prompt. Cheap (one HTTP GET).

**Every turn.** Background-prefetches semantic-search results for the upcoming user message; injects relevant prior context into the next turn's prompt.

**On demand.** Exposes two tools:

- `flair_search(query, limit?)` — semantic search across this agent's memories.
- `flair_store(content, durability?, tags?)` — persist a memory entry. Stored verbatim; no LLM extraction.

**On Hermes built-in memory writes.** Mirrors `MEMORY.md` / `USER.md` `add` operations into Flair (tagged `hermes-builtin:memory|user`) so the durable record survives even if Hermes's local files get reset.

## What this plugin deliberately doesn't do

- **No background "summarize the conversation and persist insights."** The agent decides what's worth remembering. If it wanted something stored it should have called `flair_store`.
- **No replace/remove mirroring** of Hermes built-in writes. Flair's model is append-only with explicit `supersedes` chaining; Hermes's substring-match replace doesn't translate cleanly. Replace operations stay local to MEMORY.md.
- **No cross-agent reads.** Even if the same Flair instance hosts memories for several Hermes agents, each can only see its own memories. Cross-agent memory sharing is a Flair-layer feature (`flair memory share`) not exposed through this plugin.

## Operational notes

- **Circuit breaker.** After 5 consecutive Flair API failures, the plugin pauses calls for 2 minutes to avoid hammering a down server. The agent's built-in MEMORY.md continues to work normally during the outage.
- **Non-primary contexts.** Cron-triggered Hermes runs and subagents skip Flair writes (per `agent_context` from `MemoryProvider.initialize`) to avoid corrupting the agent's representation of itself.
- **Key safety.** The Ed25519 private key never leaves the Hermes host. Only signed requests cross the wire. `chmod 600 ~/.flair/keys/<agent>.key` is enforced by `flair agent add`.

## Status

Filed alongside Flair's other agent-framework adapters (Claude Code, Gemini CLI, OpenAI Codex). Tracking issue + roadmap in the [Flair repo](https://github.com/tpsdev-ai/flair). Upstream PR for `plugins/memory/flair/` in the Hermes repo to follow.
