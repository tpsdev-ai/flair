# @tpsdev-ai/openclaw-flair

OpenClaw memory plugin for Flair — agent identity and semantic memory. Uses
[Flair](https://github.com/tpsdev-ai/flair) as the single source of truth for
agent memory, with Flair's native Harper vector embeddings — no OpenAI API key
required.

**Plugin id:** `openclaw-flair`.

## Identity (read this first)

Every Flair call the plugin makes is signed **as the agent the host is actually
serving**. The identity comes from immutable host context — the tool factory's
`ctx.agentId` or the hook's `ctx.agentId` — never from an environment variable,
a config value, or a process-wide "current agent". A configured `agentId` is an
optional **allow-list**: it can restrict which agents are served, but it never
substitutes for one, and serving any agent not on the list refuses. Missing or
mismatched identity refuses (never inherits), a missing or unusable private key
refuses (never falls back to Basic/admin or an unsigned request), and **every
refusal makes zero outgoing requests**.

> **Fixed in this version.** Earlier releases, on a gateway serving more than one
> agent, could be configured with a fixed `agentId` and would then make **every**
> agent act as that one id. If you have such a config: remove the fixed
> `agentId`, or set it to a single agent you intend to serve. On a multi-agent
> gateway that shares one OS user the plugin now **refuses to register at all**
> (`openclaw-flair disabled: agents share an OS user`) — identity cannot be
> guaranteed when every key file is readable by the same uid.

## Host compatibility

Registration is gated to an **exact tested host-version set** (`2026.8.1`,
`2026.9.6`). Outside it — or when the host version cannot be determined — the
plugin registers nothing and logs
`openclaw-flair disabled: host <v> not in tested set <s>`. This is checked as
the first thing registration does, before any hook or tool is registered, so a
mismatched host is never left half-registered. `package.json` also declares
`openclaw.install.minHostVersion` as the install-time floor; the load-time check
remains because a sideloaded copy skips the manifest.

## Installation

```bash
openclaw plugin install @tpsdev-ai/openclaw-flair
```

## Configuration

In your OpenClaw config (`openclaw.json`). The plugin owns the **memory** slot;
it deliberately does **not** take the **context-engine** slot, and it does not
suppress OpenClaw's native memory section — the host's own workspace files still
load each agent's `SOUL.md` / `AGENTS.md`.

```json
{
  "plugins": {
    "allow": ["openclaw-flair"],
    "slots": {
      "memory": "openclaw-flair"
    },
    "entries": {
      "openclaw-flair": {
        "enabled": true,
        "hooks": {
          "allowPromptInjection": true,
          "allowConversationAccess": true
        },
        "config": {
          "url": "http://127.0.0.1:19926",
          "autoRecall": true,
          "autoCapture": false,
          "maxRecallResults": 5,
          "maxBootstrapTokens": 4000
        }
      }
    }
  }
}
```

### Config options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `url` | string | `http://127.0.0.1:19926` | Flair server URL. |
| `agentId` | string | *(unset)* | Optional allow-list. When set, only this agent is served; serving any other agent refuses. **Do not** set a fixed `agentId` on a multi-agent gateway — omit it and the host supplies each agent's identity per invocation. |
| `keyPath` | string | auto-resolved | Explicit private-key path. Valid **only** with a single allowed agent (`agentId` set); otherwise the plugin refuses to register. |
| `autoRecall` | boolean | `true` | Contribute a Flair bootstrap context via the prompt hook. Requires `allowPromptInjection`. |
| `autoCapture` | boolean | `false` | Auto-capture trigger phrases from conversation. **Off by default**; requires `allowConversationAccess`. |
| `maxRecallResults` | number | `5` | Max results for `memory_search`. |
| `maxBootstrapTokens` | number | `4000` | Max tokens for the returned bootstrap context. |
| `autoCaptureMaxPerSession` | number | `3` | Cap on trigger-based auto-captures per session. |

### Required permissions

Two host gates matter and are reported at startup when missing:

- `hooks.allowPromptInjection` — required for the plugin to contribute prompt
  context. Without it: `openclaw-flair: prompt context disabled: policy`.
- `hooks.allowConversationAccess` — required for auto-capture to read
  conversation content. Without it: `openclaw-flair: capture disabled (permission)`.

Capture reads conversation content **only** through the permission-gated hooks;
it is never routed around `allowConversationAccess`.

### Prompt context

Bootstrap context is contributed through the host's returned-field contract
(`before_prompt_build` → `prependContext`). The host's base system prompt is
preserved. Logs say "returned", never "injected".

### Auto-capture

> **Auto-capture is not production-ready until slice 2.** Slice 1 keeps it
> available but **off by default**. Do not enable it in production yet.

Auto-capture scans conversation text for conservative trigger phrases (e.g.
"remember this", "we decided") and writes a matching excerpt to Flair. It runs
on `agent_end` (full-session scan) and `llm_input` / `llm_output` (live turns,
which also covers long-lived persistent gateway sessions where `agent_end` never
fires). Both share one per-session budget (`autoCaptureMaxPerSession`) and dedup
by content hash.

## Auth

Ed25519 per-agent signatures. The plugin resolves **per agent**: the private key
`keys/<agentId>.key` for the agent the host is serving, via Flair's standard key
search paths (an explicit `FLAIR_KEY_DIR`, then `~/.flair/keys/<id>.key`, then
`~/.tps/secrets/flair/<id>-priv.key`). An explicit `keyPath` is honoured only
when a single agent is allowed. If no usable key is found for the serving agent,
the call refuses (no Basic/admin, no unsigned fallback). Key files may be raw
32-byte seeds (written by `flair agent add`) or base64-encoded seeds.

## Tools

- `memory_search` → semantic search (`/SemanticSearch`)
- `memory_store` → write + embed (`PUT /Memory/<id>`)
- `memory_get` → fetch by id

All three are registered as per-invocation factories so each call signs as the
serving agent.

## License

Apache-2.0
