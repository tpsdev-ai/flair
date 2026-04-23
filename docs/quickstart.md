# Quick Start

From zero to a persistent agent memory in five minutes.

## 0. Prerequisite

**Node.js 22 or newer.** That's it — no Docker, no database to install, no API keys. Flair runs in a single process with embeddings computed locally.

```bash
node --version   # v22.x.x or higher
```

If you need Node 22: [nodejs.org](https://nodejs.org/) or `brew install node@24`.

## 1. Install (30 seconds)

```bash
npm install -g @tpsdev-ai/flair
```

`flair`, `flair-mcp`, and the client library all come in under one install.

## 2. Bootstrap Flair (1–2 minutes)

```bash
flair init
```

First run does a few things:

1. Installs the embedded Harper (memory store) into `~/.flair/data/`.
2. Downloads the local embedding model (~80 MB — first run only).
3. Starts Flair as a launchd / systemd service on port 19926.
4. Creates a default agent (`--agent-id local` unless you pass one).
5. Opens a short **soul wizard** so your agent knows who it is.

The soul wizard offers a few shapes:

```
🎭 Agent personality setup
   Soul entries shape what every future session starts with.

   What best describes this agent?
     (1) Solo developer — helps you with code on this machine
     (2) Team agent — runs in a shared repo / ops flow
     (3) Research assistant — surveys sources, writes notes
     (4) Draft from Claude — paste a Claude-generated JSON draft
     (5) Custom — I'll prompt for each field with examples
     (s) Skip — set up later; `flair doctor` will nudge
```

Pick the template that matches how you'll use this agent. You can edit or replace any entry later with `flair soul set`.

## 3. Confirm it's running

```bash
flair status
```

You should see something like:

```
Flair v0.6.0 — 🟢 running (PID 12345, uptime 1m)
  URL:        http://127.0.0.1:19926

Memory:
  Total:       0
  Durability:  0 permanent / 0 persistent / 0 standard / 0 ephemeral

Agents:
  1 total — local

Soul:
  3 entries — 0 critical / 0 high / 3 standard / 0 low

  Health:     ✅ all checks passing
```

The **🟢** icon means everything is healthy. A **🟡** would mean there's something worth looking at — usually surfaced with a recommended command inline. See [docs/troubleshooting.md](troubleshooting.md) if you see **🔴 unreachable**.

## 4. Write your first memory

```bash
flair memory add --agent local --content "Harper v5 sandbox blocks node:module but process.dlopen works"
```

Flair generates a semantic embedding locally and stores it. No network calls.

## 5. Find it back by meaning

```bash
flair memory search --agent local --q "native addon loading in sandboxed runtimes"
```

```
  Harper v5 sandbox blocks node:module but process.dlopen works
  (2026-04-22 · memory · 67%)
```

**You searched for a concept, not the keywords.** The 67% is the semantic-similarity score.

## 6. Give your agent context on boot

```bash
flair bootstrap --agent local --max-tokens 2000
```

This returns a formatted text block that includes the soul entries you just set plus recent/relevant memories. Paste that into any LLM session — Claude Code, Codex, Cursor, an Anthropic API call — to give the agent its identity + memory in one shot.

If you use Claude Code, add this to your `CLAUDE.md`:

```
At the start of every session, run mcp__flair__bootstrap before responding.
```

With the MCP server wired up (see the [integration section in README.md](../README.md#integration)), Claude Code runs bootstrap automatically on every new session.

## What's next

| You want to... | Go to |
|----------------|-------|
| Add more agents to the same instance | `flair agent add <id>` |
| Let one agent read another's memories | `flair grant <from> <to>` ([docs/auth.md](auth.md)) |
| Import memories from agentic-stack / Mem0 / etc. | [docs/bridges.md](bridges.md) |
| Sync memories across machines | [docs/federation.md](federation.md) |
| Integrate with OpenClaw, Claude Code, Cursor | [README.md#integration](../README.md#integration) |
| Fix something that isn't working | [docs/troubleshooting.md](troubleshooting.md) |
| Upgrade to a new version | `flair upgrade --restart` or [docs/upgrade.md](upgrade.md) |

## If you change your mind

```bash
flair stop              # stop the service (keeps data)
flair restart           # restart
flair uninstall         # remove the service (keeps data + keys)
flair uninstall --purge # remove everything including data and keys
```

All reversible. Your memories aren't locked in.
