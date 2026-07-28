# Quick Start

From zero to a persistent agent memory in five minutes.

## 0. Prerequisites

**Node.js 22 or newer.** No Docker, no database to install, no API keys — Flair runs in a single process and computes embeddings locally.

```bash
node --version   # v22.x.x or newer
```

Need it? [nodejs.org](https://nodejs.org/), `nvm install 22`, or `brew install node`.

**A user-writable npm global prefix.** Do not install Flair with `sudo`. A root-owned install cannot write the embedding model into its own package directory, and semantic search silently falls back to keyword-only matching. `nvm` gives you a user-owned prefix already; otherwise:

```bash
mkdir -p ~/.npm-global
npm config set prefix ~/.npm-global
export PATH="$HOME/.npm-global/bin:$PATH"   # add this to ~/.zshrc or ~/.bashrc
```

## 1. Install

```bash
npm install -g @tpsdev-ai/flair
```

One install gives you `flair`, `flair-mcp` and the client library.

## 2. Bootstrap Flair and register an agent

```bash
flair init --agent local
```

> **Pass `--agent`.** A bare `flair init` bootstraps the instance and stops there — it prints `✅ Flair initialized (no agent registered)` and creates no keypair, no soul, and no MCP wiring.

First run does six things:

1. Installs the embedded Harper memory store into `~/.flair/data/`.
2. Downloads the local embedding model — about 80 MB, first run only.
3. Starts Flair as a launchd / systemd service on port 19926.
4. Generates the agent's Ed25519 keypair in `~/.flair/keys/` and registers it.
5. Wires every MCP client it detects — Claude Code, Cursor, Codex CLI, Gemini CLI — to `npx -y @tpsdev-ai/flair-mcp`, then smoke-tests it. `--no-mcp` skips this.
6. Opens a short **soul wizard** so your agent knows who it is.

It also generates a Harper admin password and writes it to `~/.flair/admin-pass` (mode 0600). The CLI prints that **path**, never the value — read the file when a command needs the password, and prefer `--admin-pass-file ~/.flair/admin-pass` over pasting it into a command line.

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

Pick the template that matches how you'll use the agent. Edit or replace any entry later with `flair soul set`. The wizard is skipped automatically in a non-interactive shell, and by `--skip-soul`.

## 3. Confirm it's running

```bash
flair status
```

```
Flair vX.Y.Z — ✓ running  PID 12345 · uptime 0m
  URL            http://127.0.0.1:19926

Memory
  Total          0
  Durability     permanent:0 · persistent:0 · standard:0 · ephemeral:0
  Archived       0

Agents
  Total          1 — local

REM
  Nightly        disabled

Federation  not configured

Bridges  none installed

Disk
  Data           ~/.flair/data — 0 B
  Snapshots      ~/.flair/snapshots — 0 B

  ✓ all checks passing
```

You will also see a **Soul** section if you completed the wizard in step 2.

`✓` means healthy. `⚠` means something is worth looking at, and the warning names the command that fixes it. For `✗ unreachable`, see [troubleshooting.md](troubleshooting.md).

## 4. Write your first memory

```bash
flair memory add --agent local "Harper v5 sandbox blocks node:module but process.dlopen works"
```

```json
{
  "id": "local-1785277247486",
  "written": true,
  "deduplicated": false
}
```

Flair embedded the text locally on write. No network calls.

## 5. Find it back by meaning

```bash
flair search --agent local "native addon loading in sandboxed runtimes"
```

```
  Harper v5 sandbox blocks node:module but process.dlopen works
  ( 2026-07-28 · standard · 100% )
```

You searched for a concept, not the keywords. The line under each hit is its creation date, durability tier, and rank score.

> The percentage is a **rank-fusion score, not a similarity**. It is normalized so the top result is always near 100%. Read it as ordering within these results, never as confidence that the match is good.

Add `--explain` to see the ranking inputs, or `--limit`, `--tag`, `--since 7d` to narrow the search. `flair memory search` runs the same query but always prints raw JSON — use it when piping to a script.

## 6. Give your agent context on boot

```bash
flair bootstrap --agent local --max-tokens 2000
```

```
## Recent Context
📝 Harper v5 sandbox blocks node:module but process.dlopen works (2026-07-28)
✓ budget 20/2000 tokens (1%) · ✓ 1 included · ✓ 0 truncated
```

Soul entries and relevant memories, in one block sized to a token budget. Paste it into any LLM session — Claude Code, Codex, Cursor, an API call — to hand the agent its identity and memory in one shot.

Using Claude Code? Add this to your `CLAUDE.md`:

```
At the start of every session, run mcp__flair__bootstrap before responding.
```

With the MCP server wired up — `flair init` does this automatically for every client it detects — Claude Code runs bootstrap on every new session. See the [integration section in README.md](../README.md#integration).

## What's next

| You want to... | Go to |
|----------------|-------|
| Add more agents to the same instance | `flair agent add <id>` |
| Keep a memory owner-only | `flair memory add --visibility private` — reads are otherwise open to every agent on the instance ([auth.md](auth.md)) |
| Import memories from agentic-stack / Mem0 / etc. | [bridges.md](bridges.md) |
| Sync memories across machines | [federation.md](federation.md) |
| Integrate with OpenClaw, Claude Code, Cursor | [README.md#integration](../README.md#integration) |
| Fix something that isn't working | `flair doctor`, then [troubleshooting.md](troubleshooting.md) |
| Upgrade to a new version | `flair upgrade` (restarts automatically) or [upgrade.md](upgrade.md) |

## If you change your mind

```bash
flair stop              # stop the service, keep data
flair restart           # restart
flair uninstall         # remove the service, keep data and keys
flair uninstall --purge # remove everything, including data and keys
```

All reversible. Your memories aren't locked in.
