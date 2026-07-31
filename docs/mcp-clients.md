# Flair via MCP — Claude Code, Gemini CLI, OpenAI Codex CLI

Flair ships an MCP server (`@tpsdev-ai/flair-mcp`) that any MCP-compatible client can use as its persistent memory + identity layer. One server, three (and counting) integrations. Switch between agent CLIs without losing your agent's memory.

This page is the install + config snippet for each of the three major CLIs. The bootstrap is the same:

1. Install Flair and create an agent identity (one-time, ~2 min).
2. Add the MCP server to your CLI of choice (1 command or 1 file).
3. Verify the agent can call `memory_search` / `memory_store`.

If you've never set up Flair before, do step 1 first. If Flair is already running and you have an agent ID, jump to your CLI section.

---

## Step 1 — Install Flair (do once)

```bash
# Install Flair globally
npm install -g @tpsdev-ai/flair

# Initialize the local Harper-backed server
flair init

# Provision an agent identity. Pick a name — typically per-project, per-purpose,
# or "me" if you want one durable identity across everything.
flair agent add my-project
# → writes ~/.flair/keys/my-project.key (Ed25519 PKCS8) and registers the agent

# Sanity check
flair status
```

Flair runs as a local server at `http://127.0.0.1:19926` by default. The MCP server connects to it on demand via Ed25519-signed requests; nothing leaves your machine unless you explicitly route to a remote Flair instance.

---

## Step 2 — Wire the MCP server into your CLI

Pick whichever you use. The MCP server is the same package; only the config syntax differs.

> **Pin the version.** An unpinned `@tpsdev-ai/flair-mcp` re-resolves to whatever is currently published on *every* agent session, so any future publish reaches your machine silently, with no lockfile and no review step in the path. `flair init` wires clients to a **pinned** spec on purpose, and every MCP-server config snippet below is written the same way: `@tpsdev-ai/flair-mcp@<version>`.
>
> Replace `<version>` with the version you intend to run — the one you already have is `flair --version` — and bump it deliberately. Leaving the literal `<version>` in place fails loudly at `npx`, which is the intended failure: better than a config that looks pinned and isn't. `flair init` is the easier path and fills this in for you.

### Claude Code

The canonical approach is the `claude mcp add` CLI (writes to `~/.claude.json`):

```bash
claude mcp add flair --scope user \
  -e FLAIR_AGENT_ID=my-project \
  -- npx -y @tpsdev-ai/flair-mcp@<version>
```

Verify:

```bash
claude mcp list
# → flair (stdio, npx -y @tpsdev-ai/flair-mcp@<version>)
```

Or, if you prefer the project-scoped `.mcp.json` checked into your repo:

```json
{
  "mcpServers": {
    "flair": {
      "command": "npx",
      "args": ["-y", "@tpsdev-ai/flair-mcp@<version>"],
      "env": {
        "FLAIR_AGENT_ID": "my-project"
      }
    }
  }
}
```

#### Auto-recall on session start (optional hook)

The MCP server gives the agent *pull* access to memory — it calls `bootstrap` /
`memory_search` when it decides to. If you'd rather have Flair context loaded
automatically the moment a session opens (no "call the bootstrap tool" nudge),
register Flair's `SessionStart` hook. It's a separate bin shipped in the same
package and is entirely optional — it complements the MCP server, it doesn't
replace it.

The one-command way (recommended — idempotent, `--dry-run`-able, and
symmetric with `flair hook uninstall`/`flair hook status`):

```bash
flair hook install               # wires ~/.claude/settings.json for FLAIR_AGENT_ID/FLAIR_URL
flair hook install --dry-run     # prints the exact JSON delta, writes nothing
flair hook status                # wired? correct shape? which agent/instance?
flair hook uninstall             # removes only Flair's hook entry
```

`--harness claude-code` is the only supported value today (it's also the
default) — the flag exists so a future harness is an additive registry entry,
not a breaking change. `flair doctor` already checks for this same hook (see
below) and recognizes anything `flair hook install` writes.

Or wire it by hand — add a `SessionStart` hook to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "sh -c 'out=$(FLAIR_AGENT_ID=me npx -y @tpsdev-ai/flair-mcp flair-session-start 2>/dev/null) && printf %s \"$out\" || true'"
          }
        ]
      }
    ]
  }
}
```

Swap `me` for your `FLAIR_AGENT_ID`. Unlike the MCP-server snippets above, this
one is shown **unpinned**, because that is what `flair hook install` writes and
what the tooling recognises: `flair hook status` matches the exact unpinned
command, so a hand-pinned hook reports `wired: false` there (while `flair
doctor` still sees it). Pinning this line is therefore not yet supported —
prefer `flair hook install`.

The `sh -c ... || true` wrapper is not decoration. The invocation resolves a
package binary through whatever Node runtime your shell exposes, and under a
Node version manager globally installed packages are per-runtime-version — so
a routine, unrelated runtime upgrade can orphan it. Without the wrapper the
hook then fails on *every* session, forever, with an error that names neither
Flair nor a remedy, and it keeps doing so after Flair itself is uninstalled.
The wrapper makes any failure to resolve or execute produce no output and exit
0: ambient memory is a decoration on your session and must never be louder
than the thing it decorates. Success is unaffected — the hook's output is
passed through byte-for-byte.

If you already have the older, unwrapped command, `flair doctor` reports it and
`flair doctor --fix` rewrites it in place (same agent, same instance);
`flair hook status` shows the same under **On failure**.

The hook reads Claude Code's SessionStart
payload on stdin, calls Flair's `bootstrap` (soul + relevant memories +
predicted context, scoped to your project by the session's working directory),
and emits it as `hookSpecificOutput.additionalContext` — which Claude Code
injects into the new session's context. The matcher is omitted, so it fires on
every session start (`startup`, `resume`, `clear`, `compact`); add
`"matcher": "startup"` to a hook group if you only want it on fresh sessions.

It honors the same env as the MCP server (`FLAIR_AGENT_ID`, `FLAIR_URL`,
`FLAIR_KEY_PATH`), plus `FLAIR_HOOK_TIMEOUT_MS` (default 8000, clamped
500–30000) for the bootstrap timeout.

**It degrades to a no-op, always.** No `FLAIR_AGENT_ID`, Flair down, an auth
error, or a hung daemon (past the timeout) → the hook prints `{}` and exits 0.
Claude Code treats that as "no context to add" and starts normally. The hook
can never block or break session startup. The injected context is clamped to
≤10,000 characters to keep the session-start payload small. And if the command
cannot resolve at all — so none of that code ever runs — the wrapper above
still yields no output and exit 0.

`flair doctor` verifies the second half by actually running the registered
command with `FLAIR_HOOK_PROBE=1`, which makes the hook print its inert output
and exit immediately: no bootstrap, no presence write, no network. Reaching it
is the whole answer.

### Gemini CLI

Edit `~/.gemini/settings.json` (create it if absent):

```json
{
  "mcpServers": {
    "flair": {
      "command": "npx",
      "args": ["-y", "@tpsdev-ai/flair-mcp@<version>"],
      "env": {
        "FLAIR_AGENT_ID": "my-project"
      }
    }
  }
}
```

Restart your Gemini CLI session for the config to take effect. Then in chat:

```
> @flair memory_search "what did we decide about auth last week?"
```

### OpenAI Codex CLI

Edit `~/.codex/config.toml` (create it if absent):

```toml
[mcp_servers.flair]
command = "npx"
args = ["-y", "@tpsdev-ai/flair-mcp@<version>"]

[mcp_servers.flair.env]
FLAIR_AGENT_ID = "my-project"
```

For project-scoped trust (per Codex's MCP guide), the same block in `.codex/config.toml` at the project root.

Restart your Codex CLI session and the `flair_*` tools become available to the agent.

---

## Step 3 — Verify

In any of the three CLIs, ask the agent to do this:

> Use the bootstrap tool to load my Flair memory context, then store a memory that says "successful first MCP integration test."

If you see (a) the agent calling the `bootstrap` tool returning soul + recent memories, and (b) `memory_store` confirming a write — you're wired up. The memory now persists across CLI sessions AND across CLIs. Switch to a different CLI tomorrow and `memory_search "MCP integration test"` will find it.

---

## What the MCP server exposes

Eleven tools, kept deliberately small:

| Tool | What it does |
|---|---|
| `memory_search` | Semantic search across your agent's memories |
| `memory_store` | Save a memory with type, durability, tags, visibility. Auto-dedups near-duplicates |
| `memory_update` | Update an existing memory by ID — overwrite in place, or version it with `preserveHistory` |
| `memory_get` | Fetch a specific memory by ID |
| `memory_delete` | Remove a memory |
| `relationship_store` | Record a subject-predicate-object relationship triple (e.g. "nathan manages flair") |
| `bootstrap` | Get session-start context: soul + recent memories + predicted-relevant context |
| `soul_set` | Set a personality/project/standards entry — included in every bootstrap |
| `soul_get` | Get a soul entry |
| `flair_workspace_set` | Set your agent's current workspace state (ref/branch, phase, task) in the Office Space |
| `flair_orgevent` | Publish an org-wide coordination event (claim/release/status) to the Office Space |

Writes are scoped per-agent (your `FLAIR_AGENT_ID`) and enforced by Flair's server, not by client convention — you can't write as another agent. Reads are more open by design: any agent on the same Flair instance can read any other agent's **non-private** memories, with no grant to set up (open-within-org read; see [SECURITY.md](../SECURITY.md)).

Which memories are non-private is decided at write time, and the default is not "shared". `memory_store` defaults `durability` to `standard`, and the server derives visibility from durability — `permanent`/`persistent` → `shared`, `standard`/`ephemeral` → `private` — so **a bare `memory_store` call writes an owner-only memory that no other agent can read.** Pass `visibility: "shared"` (or `"private"`, to be explicit) to say what you mean; the tool reports the visibility the write actually landed on so an agent can confirm it rather than assume.

---

## Configuration reference

| Env var | Default | Notes |
|---|---|---|
| `FLAIR_AGENT_ID` | (none — required) | Must match `flair agent add <id>` |
| `FLAIR_URL` | `http://127.0.0.1:19926` | Override for remote Flair instances |
| `FLAIR_KEY_PATH` | `~/.flair/keys/<agent>.key` | Ed25519 PKCS8 key — created by `flair agent add` |

The MCP server has no client-side flags beyond these env vars; everything else (timeouts, dedup thresholds, error classification) is opinionated defaults from the underlying [`@tpsdev-ai/flair-client`](../packages/flair-client) package.

---

## What about Hermes (Nous Research)?

Hermes uses its own Python-native `MemoryProvider` ABC instead of MCP. It has its own Flair integration in [`packages/hermes-flair/`](../packages/hermes-flair). Same backend, same agent isolation, different plug shape.

Future MCP-capable agent CLIs (and there are more landing every month) will work out of the box with the MCP server above — no per-framework adapter required from us.

---

## Troubleshooting

**"FLAIR_AGENT_ID is required" on startup.** Set it in the MCP server's `env` block (per snippets above). The CLI's own env doesn't propagate to the spawned MCP subprocess unless declared.

**"connection_error: could not reach Flair at http://127.0.0.1:19926".** The Flair server isn't running. Run `flair status` to check; `flair start` to bring it up.

**"auth_error: …" on every call.** The agent identity doesn't match a registered key. Re-run `flair agent add <id>` (idempotent on re-add — won't lose existing memories).

**Tool calls succeed but the agent doesn't see results in subsequent turns.** Check that the CLI is actually invoking `bootstrap` at session start — most CLIs need an explicit prompt nudge ("call the bootstrap tool now") on first use. Subsequent turns should pick up automatically once the CLI sees the schema.

For deeper issues see [`troubleshooting.md`](troubleshooting.md) and the [`@tpsdev-ai/flair-mcp` repo](https://github.com/tpsdev-ai/flair/tree/main/packages/flair-mcp).
