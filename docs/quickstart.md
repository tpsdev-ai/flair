# Quick Start

From zero to a persistent agent memory in five minutes.

> **Need a reachable URL (Cursor cloud / Grok Bot / another machine)?** This guide is the laptop path — `flair init` binds `127.0.0.1:19926`, which those clients cannot see. Deploy on Harper Fabric instead: **[docs/quickstart-fabric.md](quickstart-fabric.md)**.

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

One install gives you one command: `flair`.

The stdio adapter your MCP client talks to is a separate package, `@tpsdev-ai/flair-mcp`, and it is deliberately not installed globally — `flair init` wires each client to fetch it on demand with `npx -y @tpsdev-ai/flair-mcp@<version>`, so there is no second global package to keep in step. (The server also has its own `/mcp` endpoint built in, but it is off by default — it registers no route unless `FLAIR_MCP_OAUTH` and a public issuer are set — and no client setup in this guide uses it.) `@tpsdev-ai/flair-client` is a separate package you add to your own project when you want to call Flair from code.

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
  "deduplicated": false,
  "visibility": "private"
}
```

Flair embedded the text locally on write. No network calls.

### Who can read it

`visibility: private` means **only `local` can read this memory** — no other agent on the instance can search it, fetch it by id, or receive it in a bootstrap.

You didn't ask for that, and it isn't a setting you have to remember. Flair derives the default from the memory's **durability**, because how long a memory is meant to last is a good proxy for who it was meant for:

| Durability | Default visibility |
|---|---|
| `permanent`, `persistent` | `shared` — a fact or decision worth keeping is worth the team being able to find |
| `standard`, `ephemeral` — including a bare write with no `--durability` | `private` — working context and scratch state belong to the agent that produced them |

So sharing is a deliberate act, and it takes one flag:

```bash
flair memory add --agent local --visibility shared \
  "Release tags are cut from main, never from a release branch"
```

`--visibility` takes exactly `private` or `shared` — a value it doesn't recognise is an error, not a guess — and overrides the durability rule in both directions. The `visibility` field in the response is the value the memory actually landed on, so read it rather than assuming.

Once a memory is `shared`, **every** agent on this instance can read it, with no grant to set up. That is the shipped model: reads open within one instance, closed at the federation edge. Full picture in [SECURITY.md](../SECURITY.md).

## 5. Find it back by meaning

```bash
flair search --agent local "native addon loading in sandboxed runtimes"
```

```
  Harper v5 sandbox blocks node:module but process.dlopen works
  ( 2026-07-28 · standard · 100% )
```

You searched for a concept, not the keywords. The line under each hit is its creation date, durability tier, and rank score.

> **When stdout is not a terminal** — piped to another command, captured in a script, or run in CI — the same `flair search` command emits a JSON array instead of the formatted prose above. Each hit is an object with `id`, `text`, `createdAt`, `durability`, and `_score` fields. Add `--explain` to include an `_explain` ranking breakdown on each hit. Use `flair search --json` to force JSON output even in a terminal, or `flair memory search` for the raw JSON form in all contexts.

> The percentage is a **rank-fusion score, not a similarity**. It is normalized so the top result is always near 100%. Read it as ordering within these results, never as confidence that the match is good.

Add `--explain` to see the ranking inputs per hit — the raw score, the composite score under `--scoring composite`, and the record's durability, age and usage count. When output is JSON (`--json`, or any time stdout is not a terminal) the same breakdown arrives as an `_explain` object on each hit, so scripts get it too. Use `--limit`, `--tag`, `--since 7d` to narrow the search. `flair memory search` runs the same query but always prints raw JSON — use it when piping to a script.

## 6. Give your agent context on boot

With MCP wired (`flair init` does this for every client it detects), the recommended session-start is the `bootstrap` tool. In Claude Code that appears as `mcp__flair__bootstrap` (Claude Code's namespaced name for the server's `bootstrap` tool). Add this to your `CLAUDE.md`:

```
At the start of every session, run mcp__flair__bootstrap before responding.
```

Use the CLI variant — `flair bootstrap --agent <id>` — when MCP is not wired: previewing context yourself, a script, or any agent that can run a shell command.

```bash
flair bootstrap --agent local --max-tokens 2000
```

```
## Recent Context
📝 Harper v5 sandbox blocks node:module but process.dlopen works (2026-07-28)
✓ budget 20/2000 tokens (1%) · ✓ 1 included · ✓ 0 truncated
```

Soul entries and relevant memories, in one block sized to a token budget. Paste that CLI output into any LLM session that does not have the MCP server — Codex, Cursor, an API call — to hand the agent its identity and memory in one shot. See the [integration section in README.md](../README.md#integration).

## What's next

| You want to... | Go to |
|----------------|-------|
| Add more agents to the same instance | `flair agent add <id>` |
| Share a memory with your other agents | `flair memory add --visibility shared` — a bare write lands `private`, see [step 4](#who-can-read-it); a shared one is readable by every agent on the instance, no grant needed ([auth.md](auth.md)) |
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
