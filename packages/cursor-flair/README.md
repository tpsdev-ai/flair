# @tpsdev-ai/cursor-flair

Cursor Marketplace plugin for [Flair](https://tps.dev/#flair) — self-hosted identity, memory, and soul for Cursor agents.

This bundle is **not an npm runtime**. It wires Cursor to the stdio MCP server [`@tpsdev-ai/flair-mcp`](https://www.npmjs.com/package/@tpsdev-ai/flair-mcp) and ships skills plus one always-on rule. Memories live in **your** Flair/Harper instance (local or a URL you run). Nothing is stored in Cursor cloud.

## Flair vs Cursor's built-in Memories

Cursor ships a native **Memories** feature: persistent notes the agent saves as you work, stored in Cursor's cloud with your Cursor account, available in Cursor. Flair is a different shape — one memory you own: self-hosted, semantically searchable, and shared across every AI you use (Cursor, Grok Bot, Claude Code, your own agents) and with your team. The two coexist: keep Memories for quick scratch notes; Flair is the memory that follows you across tools.

## Prerequisites

A running Flair instance and an agent identity.

**Laptop (this machine only):**

```bash
npm i -g @tpsdev-ai/flair
flair init --agent <id>    # Harper + agent + key at ~/.flair/keys/<id>.key
flair status               # default HTTP origin: http://127.0.0.1:19926
```

**Grok Bot / Cursor cloud / another machine:** `127.0.0.1:19926` is not reachable. Start on Harper Fabric: **[docs/quickstart-fabric.md](../../docs/quickstart-fabric.md)**.

`<id>` must match the `FLAIR_AGENT_ID` you configure in the plugin. Node.js **>= 22** is required on the machine that runs `npx` (the MCP server's engines field).

## Install

**Marketplace.** In Cursor, search **Flair** in the Marketplace, install, then **Plugins → Configure**.

**Local development.** Copy or symlink this directory to `~/.cursor/plugins/local/flair`, then Configure the same variables.

## Configure

Set these under **Plugins → Configure**. `FLAIR_CLIENT=cursor` is set for you in `mcp.json` — do not add it as a variable.

| Variable | Required | Default | Notes |
|---|---|---|---|
| `FLAIR_AGENT_ID` | yes | — | Must match `flair agent add <id>` |
| `FLAIR_URL` | no | `http://127.0.0.1:19926` | Reachable Flair HTTP origin |

Those are the only two fields in the plugin schema (`plugin.json`). `FLAIR_KEY_PATH` and `FLAIR_ADMIN_*` are documented here in the README only — they are **not** declared as plugin variables and **not** interpolated into `mcp.json`. Set them in the host env of the machine that runs `npx`. Keeping them out of `mcp.json` is deliberate: an unsubstituted `${FLAIR_KEY_PATH}` would be truthy and break key auto-resolve, and an unsubstituted admin password would send literal Basic auth.

## Grok Bot / Cursor cloud agents

`npx` runs on the **agent machine**. That process's `localhost` is not your laptop. Laptop `flair init` on `127.0.0.1:19926` is not reachable from Grok Bot or Cursor cloud agents.

**Start on Harper Fabric** when you need a public URL: **[docs/quickstart-fabric.md](../../docs/quickstart-fabric.md)**. Deploy, register an agent with `--target`, then paste that `https://<cluster>.<org>.harperfabric.com` origin into `FLAIR_URL`. Fabric is Harper-hosted, not a Flair-operated cloud.

- Set `FLAIR_URL` to an origin the agent VM can reach. The default `http://127.0.0.1:19926` points at the npx host, which on a cloud agent is the cloud VM.
- The agent key lives on the **npx host** at `~/.flair/keys/<id>.key` (or `FLAIR_KEY_PATH` in that machine's environment). If you cannot mount a key, set `FLAIR_ADMIN_USER` / `FLAIR_ADMIN_PASSWORD` in the host env of the machine that runs `npx` — not in plugin Configure.
- Node **>= 22** must be on that same machine.

## Skills

| Skill | When |
|---|---|
| `bootstrap` | Session start, resume, "who am I / what do we remember?" |
| `context-loader` | New task, context switch, "what did we decide about X?" |
| `remember` | Decisions, lessons, preferences, facts, or "remember this" |
| `update` | Correct or version a memory by id |
| `forget` | Delete a specific memory after a preview (no wipe-all) |
| `soul` | Read/write role, standards, project — only on explicit request |
| `relate` | Subject/predicate/object triples, not prose |
| `health` | Tool failures; probe with `bootstrap` (there is no Health tool) |
| `coordinate` | Multi-agent claim/release; skip for solo local memory |

## Verify

Ask the agent:

> Load my Flair bootstrap, then store a test memory

You should see `bootstrap` return soul + memories, then `memory_store` confirm an id.

## Not this plugin

- Built-in Flair `/mcp` OAuth — off by default; a different surface
- Claude Code `flair-session-start` hook — Claude-only; do not run it from Cursor
- OpenClaw, n8n, Hermes, LangGraph, Pi, ADK packages — other harnesses, same Flair backend

## Troubleshooting

Use the **health** skill first. Then see [`docs/mcp-clients.md`](https://github.com/tpsdev-ai/flair/blob/main/docs/mcp-clients.md) in the Flair repo.

Typical failures: Flair not running on `FLAIR_URL`, `FLAIR_AGENT_ID` unset (Configure it), key missing on the npx host, or a cloud agent pointed at laptop localhost.

## License

Apache-2.0
