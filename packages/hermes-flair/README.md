# Flair memory plugin for Hermes

[Flair](https://github.com/tpsdev-ai/flair) is the open-source memory + identity layer for agents. This plugin makes Flair the durable memory backend for [Hermes](https://github.com/NousResearch/hermes-agent) agents — per-agent-scoped, Ed25519-signed, semantic-searchable.

## Why Flair underneath Hermes

Hermes already ships great built-in memory (MEMORY.md / USER.md). Flair extends it with:

- **Per-agent write scoping for non-admin agents.** Configure a separate registered Flair agent ID and matching Ed25519 key for each Hermes identity you want to distinguish. The server rejects a non-admin write attributed to another agent; admin credentials have broader authority. A non-admin reader can access its own memories and other agents’ non-private memories on the instance. This plugin cannot set visibility: fresh permanent and persistent writes default to shared, while standard and ephemeral writes default to private.
- **Agent-authored, no LLM-extraction-on-every-turn.** The agent decides what's worth remembering via the `flair_store` tool. No silent server-side fact extraction, no surprise persistence.
- **Self-hosted, no SaaS dependency.** Runs on a Mac Mini, a Raspberry Pi, or a cloud VM. Single Harper-backed binary.
- **Memory from one place.** Startup makes one Memory collection request filtered by the configured agent ID and limited by `bootstrap_limit`. It does not query Soul or Agent or request recency ordering; it moves returned permanent rows ahead of the other returned rows.
- **Portable across orchestrators.** The same Flair memory works under Hermes, Claude Code, Gemini CLI, OpenAI Codex CLI, and any other agent runtime that has a memory plugin slot. Switch orchestrators without losing your agent's state.

## Setup

```bash
# 1. Install Flair
npm i -g @tpsdev-ai/flair
flair init

# 2. Provision an Ed25519 identity for your Hermes agent
flair agent add hermes
# → writes ~/.flair/keys/hermes.key (a raw 32-byte Ed25519 seed)
# When creating a new key, `flair agent add` writes a raw 32-byte Ed25519 seed.
# The plugin also accepts Ed25519 PEM and canonically base64-encoded PKCS8 DER
# after text normalization. `agent add` does not write the alternative formats,
# and it reuses an existing key file.

# 3. Activate this plugin in Hermes
hermes memory enable flair
```

## Configuration

Provide via environment variables, or `$HERMES_HOME/flair.json`:

| Setting          | Env var          | Default                             | Notes                                           |
|------------------|------------------|-------------------------------------|-------------------------------------------------|
| Server URL       | `FLAIR_URL`      | `http://127.0.0.1:19926`             | Override for remote Flair deployments           |
| Agent ID         | `FLAIR_AGENT_ID` | `hermes`                            | Must match `flair agent add <id>`               |
| Private key path | `FLAIR_KEY_PATH` | `~/.flair/keys/<agent>.key`         | When creating a new key, `flair agent add` writes a raw 32-byte Ed25519 seed. The plugin also accepts Ed25519 PEM and canonically base64-encoded PKCS8 DER after text normalization. `agent add` does not write the alternative formats, and it reuses an existing key file. |

Example `flair.json`:

```json
{
  "url": "http://127.0.0.1:19926",
  "agent_id": "hermes",
  "bootstrap_limit": 10,
  "recall_limit": 5
}
```

## What this plugin does

**At session start.** The plugin requests up to `bootstrap_limit` Memory rows for the configured agent, puts returned permanent rows first, and inserts nonempty snippets into the system prompt. It does not request a recency sort or query Soul or Agent.

**Every turn.** Background-prefetches semantic-search results for the upcoming user message; injects relevant prior context into the next turn's prompt.

**On demand.** Exposes two tools:

- `flair_search(query, limit?)` — semantic search using Flair's read scope (own records and other agents' non-private records).
- `flair_store(content, durability?, tags?)` — persist a memory entry. Stored verbatim; no LLM extraction. `flair_store` sends content and durability without a `visibility` field. For a fresh record, Flair defaults permanent and persistent to shared, and standard and ephemeral to private.

**On Hermes built-in memory writes.** Mirrors `MEMORY.md` / `USER.md` `add` operations into Flair (tagged `hermes-builtin:memory|user`) so the durable record survives even if Hermes's local files get reset.

## What this plugin deliberately doesn't do

- **No background "summarize the conversation and persist insights."** The agent decides what's worth remembering. If it wanted something stored it should have called `flair_store`.
- **No replace/remove mirroring** of Hermes built-in writes. The plugin attempts to mirror `add` operations from `MEMORY.md` and `USER.md`; `replace` and `remove` stay in the corresponding local file, although Flair supports in-place updates and deletion.
- **Cross-agent reads are possible within Flair's read scope:** own records and other agents' non-private records on the instance.

## Operational notes

- **Circuit breaker.** After 5 consecutive Flair API failures, the plugin pauses calls for 2 minutes to avoid hammering a down server. The agent's built-in MEMORY.md continues to work normally during the outage.
- **Non-primary contexts.** Cron-triggered Hermes runs and subagents skip Flair writes (per `agent_context` from `MemoryProvider.initialize`) to avoid corrupting the agent's representation of itself.
- **Key safety.** The Ed25519 private key never leaves the Hermes host. Only signed requests cross the wire. `chmod 600 ~/.flair/keys/<agent>.key` is enforced by `flair agent add`.

## Status

Filed alongside Flair's other agent-framework adapters (Claude Code, Gemini CLI, OpenAI Codex). Tracking issue + roadmap in the [Flair repo](https://github.com/tpsdev-ai/flair). Upstream PR for `plugins/memory/flair/` in the Hermes repo to follow.
