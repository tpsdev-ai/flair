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

> **`flair: command not found` right after installing?** Your npm global prefix's bin dir isn't on PATH (common with a user prefix like `~/.npm-global`) — run `export PATH="$(npm prefix -g)/bin:$PATH"`, persist that line in your shell profile, and `flair doctor` will print the exact line for your shell any time.

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

`--harness` defaults to `claude-code`. `codex` is also supported (writes
`~/.codex/hooks.json` — see the Codex section below). `flair doctor` checks
the same hook for each detected harness and recognizes anything
`flair hook install` writes.

Or wire it by hand — add a `SessionStart` hook to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "sh -c 'out=$(FLAIR_AGENT_ID=me npx -y -p @tpsdev-ai/flair-mcp@<version> flair-session-start 2>/dev/null) && printf %s \"$out\" || true'"
          }
        ]
      }
    ]
  }
}
```

Swap `me` for your `FLAIR_AGENT_ID` and `<version>` for `flair --version`. This
is the same pin `flair init` writes into client MCP configs (`mcpServerSpec()`,
flair#907): a wired hook should not self-update to a freshly published
`flair-mcp` any more than a wired MCP client should. `flair hook install`,
`flair init`, and `flair doctor --fix` (when adding a missing hook) write that
pin; re-run `flair hook install` to advance a stale or pre-#1143 unpinned hook
to the running CLI's version.

That is a different surface from public plugin `mcp.json` files, which stay
**unpinned** on purpose (flair#1308) so directory listings that scrape them do
not freeze on a shipped version. User-local wiring is pinned; catalog
manifests are not.

`flair hook status` recognises both the current pinned `-p` form and an older
unpinned `-p` invocation as `correctShape`. The pre-#1166 form (no `-p`, which
runs the MCP shim) is still flagged. Prefer `flair hook install` over
hand-editing.

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

#### Auto-recall on session start (optional hook)

Wiring the MCP server alone does not load memory at session start — Codex
then has pull tools it never thinks to call. The same `flair-session-start`
command Claude Code uses writes Codex's SessionStart hook (same JSON schema,
into `~/.codex/hooks.json`):

```bash
flair hook install --harness codex
flair hook status --harness codex
flair hook uninstall --harness codex
```

`flair doctor` reports this hook when Codex is detected. After install, trust
the new command in Codex with `/hooks` — untrusted hooks are listed and
skipped.

---

## Hookless harnesses (Gemini, Cursor, and anything without SessionStart)

Some clients have no session-start hook Flair can write. Wiring the MCP
server is necessary but not sufficient — the model still has to choose to
call `bootstrap`. Add a short instruction block to the file that client
already loads (`AGENTS.md`, `GEMINI.md`, or the equivalent):

```markdown
## Flair memory

At the start of every session, call the Flair `bootstrap` tool before
responding. Before a deep-dive, `memory_search` for related prior work.
At wrap, `memory_store` durable lessons.
```

Without that, a config that looks wired is the known failure shape
([#989](https://github.com/tpsdev-ai/flair/issues/989),
[#908](https://github.com/tpsdev-ai/flair/issues/908)): tools exist, memory
never enters the working set. Use `flair hook install` when the client has
a SessionStart hook; use this static block when it does not.

---

## Step 3 — Verify

In any of the three CLIs, ask the agent to do this:

> Use the bootstrap tool to load my Flair memory context, then store a memory that says "successful first MCP integration test."

If you see (a) the agent calling the `bootstrap` tool returning soul + recent memories, and (b) `memory_store` confirming a write — you're wired up. The memory now persists across CLI sessions AND across CLIs. Switch to a different CLI tomorrow and `memory_search "MCP integration test"` will find it.

---

## What the MCP server exposes

Twelve tools, kept deliberately small:

| Tool | What it does |
|---|---|
| `memory_search` | Semantic search across your agent's memories |
| `memory_store` | Save a memory with type, durability, tags, visibility. Auto-dedups near-duplicates. Optional `usedMemoryIds` cites memories that informed the write |
| `memory_update` | Update an existing memory by ID — overwrite in place, or version it with `preserveHistory`. Optional `usedMemoryIds` for citation-on-write |
| `memory_get` | Fetch a specific memory by ID |
| `memory_delete` | Remove a memory |
| `relationship_store` | Record a subject-predicate-object relationship triple (e.g. "nathan manages flair") |
| `bootstrap` | Get session-start context: soul + recent memories + predicted-relevant context |
| `soul_set` | Set a personality/project/standards entry — included in every bootstrap |
| `soul_get` | Get a soul entry |
| `flair_workspace_set` | Set your agent's current workspace state (ref/branch, phase, task) in the Office Space |
| `flair_orgevent` | Publish an org-wide coordination event (claim/release/status) to the Office Space |
| `record_usage` | Report that recalled memories were actually used (id + optional one-line how-it-was-used). Drives `usageCount` / `usageBoost` |

Writes are scoped per-agent (your `FLAIR_AGENT_ID`) and enforced by Flair's server, not by client convention — you can't write as another agent. Reads are more open by design: any agent on the same Flair instance can read any other agent's **non-private** memories, with no grant to set up (open-within-org read; see [SECURITY.md](../SECURITY.md)).

Which memories are non-private is decided at write time, and the default is not "shared". `memory_store` defaults `durability` to `standard`, and the server derives visibility from durability — `permanent`/`persistent` → `shared`, `standard`/`ephemeral` → `private` — so **a bare `memory_store` call writes an owner-only memory that no other agent can read.** Pass `visibility: "shared"` (or `"private"`, to be explicit) to say what you mean; the tool reports the visibility the write actually landed on so an agent can confirm it rather than assume.

### Reading the `bootstrap` payload

`bootstrap` returns the canonical structured containers — `soul`, `memories`, `predicted`, `teammateFindings`, `events` — plus counts and a `tokenEstimate`. The containers are **always present** (empty `[]`/`{}` when there's nothing), so an empty container is distinguishable from an unsupported one.

**The token ledger reconciles `tokenEstimate` from the payload alone (flair#1270).** Every token-charged content class carries a counter — `soulTokens`, `memoryTokens`, `trustTokens`, `eventsTokens` — plus a measured `scaffoldTokens` for the fixed JSON frame, and `tokenEstimate ≈ scaffoldTokens + soulTokens + memoryTokens + trustTokens + eventsTokens`. The remaining ≈ gap is the bounded per-item difference between the prose lines the memory counters measure and the heavier structured objects the containers ship. A payload whose estimate an agent can't decompose from the reported figures is a bug, not an accounting convention.

**Empty containers say why they're empty (flair#1182).** When a structured container ships empty, the payload carries a short hint naming the reason and what fills it — `eventsHint`, `teammateFindingsHint`, `predictedHint`. This is present *only* when the container is empty, so a deliberately-empty container is never confused with a silent drop (a connector never has to diff against a previous payload to tell the two apart).

**`matchQuality` is null on lifecycle sections — by design (flair#1225).** With `includeTrust: true`, each included memory carries a per-memory trust block, section-tagged, whose `matchQuality` is a `strong`/`moderate`/`breadcrumb` confidence band. On the **lifecycle sections** (`permanent`, `recent`, `predicted`) `matchQuality` is `null`: those are a lifecycle-window *load*, not a retrieval surface, so there is no relevance score to band. This is **correct, not a scoring failure** — an own-recent `null` next to a teammate's band does not mean your own records "scored worse". A retrieval band is only meaningful on the retrieval sections (`relevant`, `teammate`). The entry's `section` field makes this legible, and a `matchQualityNote` on any null entry states the reason inline.

---

## Configuration reference

| Env var | Default | Notes |
|---|---|---|
| `FLAIR_AGENT_ID` | (none — required) | Must match `flair agent add <id>` |
| `FLAIR_URL` | `http://127.0.0.1:19926` | Override for remote Flair instances |
| `FLAIR_KEY_PATH` | `~/.flair/keys/<agent>.key` | Ed25519 PKCS8 key — created by `flair agent add` |

The MCP server has no client-side flags beyond these env vars; everything else (timeouts, dedup thresholds, error classification) is opinionated defaults from the underlying [`@tpsdev-ai/flair-client`](../packages/flair-client) package.

---

## What about pi?

pi has no MCP client support, so Flair ships a **native pi extension** instead: [`@tpsdev-ai/pi-flair`](../packages/pi-flair/README.md). Same backend, same agent isolation, zero MCP in the path.

Wiring is a `packages` entry in pi's own settings (`~/.pi/agent/settings.json`), not an `mcpServers` block:

```json
{
  "packages": ["npm:@tpsdev-ai/pi-flair@<version>"]
}
```

`flair init --client pi` writes exactly that (pinned), or use pi's own installer: `pi install npm:@tpsdev-ai/pi-flair`. `flair doctor` detects pi and checks the wiring — including the one known trap: **an `npm:` spec under the `extensions` settings key is silently ignored by pi** (`extensions` takes local file paths only; package sources belong under `packages` — [#1346](https://github.com/tpsdev-ai/flair/issues/1346)). Doctor calls that misconfiguration out by name, and `flair doctor --fix` moves the entry.

One difference from the MCP clients above: pi settings carry no per-package `env` block, so `FLAIR_AGENT_ID` (and `FLAIR_URL` when non-default) must be exported in the environment that launches pi. Doctor reports what it sees in its own shell and says so — it cannot observe the environment of every pi launch.

---

## What about Hermes (Nous Research)?

Hermes uses its own Python-native `MemoryProvider` ABC instead of MCP. It has its own Flair integration in [`packages/hermes-flair/`](../packages/hermes-flair). Same backend, same agent isolation, different plug shape.

Future MCP-capable agent CLIs (and there are more landing every month) will work out of the box with the MCP server above — no per-framework adapter required from us.

---

## Troubleshooting

**"FLAIR_AGENT_ID is required" on startup.** Set it in the MCP server's `env` block (per snippets above). The CLI's own env doesn't propagate to the spawned MCP subprocess unless declared.

**"connection_error: could not reach Flair at http://127.0.0.1:19926".** The Flair server isn't running. Run `flair status` to check; `flair start` to bring it up.

**"auth_error: …" on every call.** The agent identity doesn't match a registered key. Re-run `flair agent add <id>` (idempotent on re-add — won't lose existing memories). Against a hosted instance the same three shapes apply (record missing / key mismatch / config wrong), and a by-id 404 is fail-closed ownership, not an existence signal — [Hosted Flair auth](integrations.md#hosted-flair-auth--your-agent-got-a-404).

**Tool calls succeed but the agent doesn't see results in subsequent turns.** Check that the CLI is actually invoking `bootstrap` at session start — most CLIs need an explicit prompt nudge ("call the bootstrap tool now") on first use. Subsequent turns should pick up automatically once the CLI sees the schema.

For deeper issues see [`troubleshooting.md`](troubleshooting.md) and the [`@tpsdev-ai/flair-mcp` repo](https://github.com/tpsdev-ai/flair/tree/main/packages/flair-mcp).
