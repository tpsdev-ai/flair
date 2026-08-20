# Flair + DeepSeek Harness (zero-code MCP bridge)

Give DeepSeek Harness (DSH) sessions persistent, portable memory — no plugin code, just one Cordis overlay wiring [`@tpsdev-ai/flair-mcp`](../packages/flair-mcp) through DSH's first-party MCP bridge, [`@deepseek-ai/dsh-mcp-client`](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/mcp/mcp-client).

> **Verified against DSH as of 2026-08-20** (`deepseek-ai/deepseek-harness`, branch `master`). DSH is a developer preview and its own README promises compatibility-breaking changes. If wiring fails after a DSH upgrade, re-check the config field names against [their MCP client README](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.md) before suspecting Flair.

The same eleven tools every other MCP client gets ([full table in mcp-clients.md](mcp-clients.md#what-the-mcp-server-exposes)) appear to the model under DSH's server-qualified names: `mcp__flair__memory_search`, `mcp__flair__memory_store`, `mcp__flair__bootstrap`, and so on — the same `mcp__<server>__<tool>` convention Claude Code uses.

Two caveats up front, both structural to DSH's bridge (details below):

1. **DSH scrubs the ambient environment before spawning MCP servers.** Flair's env vars must be declared in the overlay's `config.env` — exported shell vars will not reliably reach the server.
2. **Recall on this path is reactive.** The model must *choose* to call the memory tools; DSH's MCP bridge cannot inject Flair context at session start. There is a documented mitigation (a persona nudge), but real auto-inject requires a native DSH plugin — planned as phase 2 of [flair#1289](https://github.com/tpsdev-ai/flair/issues/1289).

## Prerequisites

Same as every MCP client — a running Flair and an agent identity. Follow [Step 1 of mcp-clients.md](mcp-clients.md#step-1--install-flair-do-once) (install, `flair init`, `flair agent add <id>`, `flair status`). If DSH runs on a machine that cannot see your Flair instance's loopback address, you need a reachable `FLAIR_URL` — see [quickstart-fabric.md](quickstart-fabric.md).

DSH spawns the server with `npx`, so the machine running DSH needs Node.js 22+ (Flair's own floor).

## The overlay

A ready-to-use copy of this file ships in the repo at [`examples/deepseek-harness/flair.cordis.yml`](../examples/deepseek-harness/flair.cordis.yml):

```yaml
- insert:
    - id: memory-flair
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: flair
        transport: stdio
        command: npx
        args: ['-y', '@tpsdev-ai/flair-mcp@<version>']
        env:
          FLAIR_AGENT_ID: <agent-id>
          FLAIR_URL: http://127.0.0.1:19926
```

Replace the two placeholders before use:

- `<version>` — pin the flair-mcp version you intend to run (the one you already have is `flair --version`). The [pinning rationale from mcp-clients.md](mcp-clients.md#step-2--wire-the-mcp-server-into-your-cli) applies with extra force here: DSH re-spawns the command per session, so an unpinned spec re-resolves to whatever is currently on npm every time. Leaving the literal `<version>` in place fails loudly at `npx` — intended.
- `<agent-id>` — the identity you created with `flair agent add`.

`FLAIR_URL` as shown is the local default; point it at your Fabric URL for a remote instance.

Apply it for one run:

```sh
dsh web --patch "$PWD/examples/deepseek-harness/flair.cordis.yml"
```

To keep it across runs, merge the single `insert` patch into a user patch layer — `$DSH_HOME/profiles/<name>/cordis.patch.yml` for one profile, or `$DSH_HOME/cordis.patch.yml` machine-wide. Merge into an existing file rather than copying over it; it may already carry unrelated patches.

DSH's own reference memory overlays prefer a preinstalled binary over a package runner ("DSH starts it but does not run a package manager"). If you want that shape: `npm install -g @tpsdev-ai/flair-mcp@<version>`, then `command: flair-mcp` with no `args`.

## Caveat 1 — the bridge scrubs ambient env; declare Flair's env explicitly

Before spawning a stdio MCP server, DSH's bridge builds the child environment from a **scrubbed** copy of the parent env: every variable whose name matches `KEY`, `PASSWORD`, `SECRET`, or `TOKEN` (case-insensitive) is dropped, and so is every `DSH_*` variable. The overlay's `config.env` is merged **after** the scrub, so it is the one reliable channel.

Concretely for Flair:

- `FLAIR_KEY_PATH` contains `KEY` — an exported value is **silently dropped**. If your Ed25519 key is not at the default `~/.flair/keys/<agent>.key`, you must set `FLAIR_KEY_PATH` in `config.env`.
- `FLAIR_AGENT_ID` and `FLAIR_URL` happen to survive today's scrub pattern, but the pattern is DSH's to change. Declare all three in `config.env` and depend on none of the ambient env.

This mirrors the general rule from [mcp-clients.md troubleshooting](mcp-clients.md#troubleshooting) — a client's own env does not propagate to the spawned MCP subprocess unless declared — DSH just enforces it deliberately.

## Caveat 2 — recall is reactive on this path

DSH's MCP bridge registers **tools** on the model's tool list. That is all it can do: DSH has no first-class memory seam, and the bridge has no way to run `bootstrap` at session start and inject the result into context. Whether memory gets consulted is the model's per-turn decision — identical to the behavior DSH documents for its own reference memory servers.

The documented mitigation is a standing prompt nudge. DSH's deployment persona is the `persona` config key on its `system-prompt` row (agent presets can shadow it with a persona row of their own; there is no end-user prompt-editing API — prompt text is config/composition only). Add something like:

> At the start of a task, call `mcp__flair__bootstrap` or `mcp__flair__memory_search` to load relevant memory before planning. When you make a decision worth keeping, or the user asks you to remember something, record it with `mcp__flair__memory_store`.

This is additive guidance in the shape DSH's own memory examples recommend, and it works — but it is a nudge, not a guarantee. **Honest limitation:** automatic session-start injection (what Flair's Claude Code `SessionStart` hook does) requires a native DSH plugin using their per-turn system-prompt context seam. That is phase 2 of [flair#1289](https://github.com/tpsdev-ai/flair/issues/1289); until it ships, this wiring gives pull-based memory only.

## Tools-only bridging

DSH bridges MCP **tools** only — Resources and Prompts are explicitly not bridged (a documented DSH limitation, not a Flair one). This costs nothing here: `flair-mcp` is a tools-only server, so its entire surface crosses the bridge.

## Verify your wiring

Initial tool discovery is asynchronous — wait until the `mcp__flair__*` tools appear in the session's tool list before the first prompt. Then run the write → fresh-session → recall check (the same protocol shape DSH uses to validate its own reference memory servers):

1. In DSH session A, ask: *"Remember that my validation drink is lapsang-`<unique suffix>`."* Confirm the model calls `mcp__flair__memory_store` and the tool reports success.
2. Open DSH session B in the same running Host — do not copy session A's conversation. Ask: *"What is my validation drink? Check memory."* Confirm the model calls `mcp__flair__memory_search` and returns the value.
3. Still in session B, ask it to *use* the recalled value ("suggest one drink for the meeting"). Confirm the answer builds on it.

A new DSH session is enough; a Host restart is not. Because the memory now lives in Flair rather than a local file, the same check also passes *across harnesses*: store in DSH, then `memory_search` from Claude Code or any other [MCP client](mcp-clients.md) pointed at the same Flair instance and agent.

## Config reference (the fields this wiring uses)

Field names verified against DSH `master` 2026-08-20; [their table](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.md) is authoritative.

| Field | Value here | Notes |
|---|---|---|
| `serverName` | `flair` | Namespace for tool names (`mcp__flair__*`); must be unique across live instances |
| `transport` | `stdio` | flair-mcp is a stdio server |
| `command` / `args` | `npx` / `['-y', '@tpsdev-ai/flair-mcp@<version>']` | Or a preinstalled `flair-mcp` binary |
| `env` | `FLAIR_AGENT_ID`, `FLAIR_URL`, optionally `FLAIR_KEY_PATH` | Merged after DSH's env scrub — the only reliable channel (see caveat 1) |
| `toolCallTimeoutMs` | (default 60000) | Per-tool-call timeout; raise it only if slow remote searches genuinely exceed a minute |

## Troubleshooting

**"FLAIR_AGENT_ID is required" on startup.** The env block is missing or ambient-only — declare it in `config.env` (caveat 1).

**Tools never appear.** DSH logs initial connection and discovery failures; by default a failed startup registers no tools rather than failing the plugin. Check `flair status` on the Flair side, and check the DSH logs for the `flair` server's connect errors. A duplicate `serverName: flair` across live instances fails the later instance at load.

**`auth_error` on every call.** Identity/key mismatch — and remember that an exported `FLAIR_KEY_PATH` never reaches the server (caveat 1). Re-run `flair agent add <id>` (idempotent) or set `FLAIR_KEY_PATH` in `config.env`.

For everything else: [troubleshooting.md](troubleshooting.md).
