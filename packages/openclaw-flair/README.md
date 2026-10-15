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
| `autoCaptureMaxPerSession` | number | `3` | Cap on trigger-based auto-captures **per run**. |

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

Off by default. When enabled — and only with the host's `allowConversationAccess`
permission — the plugin writes a matching excerpt to Flair when conversation text
carries a conservative trigger phrase ("remember this", "we decided", …). These
are the guarantees it keeps, each with the test that proves it in
`packages/openclaw-flair/test/plugin.test.ts`:

- **Capture is off by default.** With `autoCapture` unset no capture hook is
  registered and no capture write happens, however the turn runs — recall is a
  separate feature, and its own hook may still make a bootstrap read —
  `capture is OFF by default: permission granted, no autoCapture config -> no
  capture hooks and no capture writes`.
- **Captures are keyed per agent and per run.** Two concurrent runs of one agent
  share neither the session cap nor the dedup set, and every write is signed as
  the agent whose callback produced it — `D10 (mutation: state keyed by agent
  only): two concurrent runs of one agent share neither the session cap nor the
  dedup set`; `R10: interleaved agents, driven through the host's turn order,
  sign as themselves`.
- **While the plugin holds a session's state, a session-keyed `agent_end` scan
  treats a message as already seen only if the session records its identity, and
  the identity cap does not drop a recorded identity the current snapshot
  holds.** The host gives a snapshot message no host-owned id or position (its
  only ordering field is a `Date.now()` timestamp, which can tie), so no message
  is skipped because of its timestamp — `flair#2560 (mutation: a timestamp
  mark): a new message is captured whether its timestamp ties with, precedes or
  follows the session's earlier messages, and a later non-capturable message
  hides none`. The identity hashes the role, the JSON content and the timestamp
  with its type, so messages whose encoded fields differ have different
  identities, barring digest collisions — `flair#2560 (mutation: untyped
  timestamp): a numeric and a string timestamp give different identities`. While
  the state is held, a session's recorded identities number at most
  max(`sessionMessageCap` (4,096), D), where D is the number of distinct
  identities in the last snapshot it accounted for; disabled callbacks do not
  update it. Deferred identities (below) hold only that snapshot's identities,
  so at most D. The cap evicts only identities that have left the snapshot, so a
  recorded message that stays in the snapshot is not offered again, however
  long the session; one that
  left the snapshot can be evicted and, if it reappears, captured again —
  `flair#2560 (mutation: a live identity is evicted): a snapshot over
  sessionMessageCap distinct messages, across several runs: the message each run
  appends is captured and nothing earlier is captured again`; `flair#2560
  (mutation: deferred is never pruned): entries stay within
  max(sessionMessageCap, D) and deferred holds only last-accounted-snapshot identities`.
  The scan walks the supplied snapshot from its last position, so a run's
  capture cap (`autoCaptureMaxPerSession`) is spent on the last eligible
  positions; that is position, not proof of which run added a message. In a warm
  session a message the cap leaves out stays unseen (deferred) and remains
  eligible for a later capture scan unless settled, subject to its gates and cap, and
  if a later scan captures it, the row carries that later run's id only when it
  passes the `hostSource` grammar; otherwise it lands without that field, with
  a rate-limited warning. Another cap can leave it unseen. A refused scan settles
  its occurrences, including identical copies: their origin is ambiguous. Preserving deferred messages
  while excluding refused-run copies fully needs a stable host-owned message
  identity; that is a follow-up.
  Same-run excerpt dedup settles it without a new write. A failure before the
  write, a write that starts and then fails, or a write whose run is aborted
  while it is in flight records it as skipped if the scan continues past its
  stop and disable check, because an aborted write may still have reached Flair —
  `flair#2560 (mutation: oldest first; mutation: a capped message recorded as
  seen): a run's cap is spent from the last snapshot position, and the message
  it left out is captured by the next capture scan`; `flair#2560: a refused
  scan settles a message an earlier cap deferred`; `flair#2560: abort before a
  deferred message's write starts settles it`; `flair#2560
  (mutation: a discarded write leaves the message deferred): when a run is
  aborted while a deferred message's own write is in flight, the message is
  recorded as skipped and not captured again`. The limit is a session's first
  scan in this process: for a new session, after its state is evicted past
  `sessionStateCap`, or after a gateway restart (the state is held in process
  memory and cleared at `gateway_stop`). That scan cannot tell which messages a
  run added, so it offers the last eligible positions up to the run's cap and
  records the rest of the identifiable messages as seen, including any the run
  added beyond the cap. A message captured before can be captured again, if it
  passes the trigger rule, the run's dedup and cap, and its write succeeds; it
  then lands as a second row. The row carries the current run's id only when
  it passes the `hostSource` grammar; otherwise it lands without that field,
  with a rate-limited warning — `flair#2560 cold start (mutation: a cold scan
  leaves capped messages unseen): a session's first scan captures at most the run's cap, from the last eligible position, and
  records the rest as seen`. Flair's near-duplicate check can flag such a write
  `deduplicated`, naming a near-matching row (`matchedId`); it does not suppress
  the write. The plugin counts flagged auto-captures since it registered and
  logs a line at the 1st, 2nd, 4th, … one: no line for n = 0 flagged captures,
  and floor(log2 n) + 1 lines for n ≥ 1 — `flair#2560 (mutation: the
  deduplicated flag is ignored): a capture Flair flags deduplicated is counted,
  with a log line at the 1st, 2nd, 4th, ... one`; `flair#2560 (mutation: a
  32-bit power-of-two check): the repeat log points are exactly the powers of
  two, for any count`; against a real Flair component, `flair#2560 cold start
  (mutation: the deduplicated flag is ignored): after gateway_stop and a new
  registration, a re-delivered message is captured again; Flair stores the
  repeat as a second row, flags it deduplicated, and the plugin counts it` in
  `test/integration/agent-end-session-capture-2560.test.ts`.
- **Memory is bounded.** The run map holds at most `capacityCap` records, plus at
  most `abortOverflowCap` records for aborted runs that were never admitted, and a
  new run is refused rather than evicting a live record — `(a) repeated aborts of
  NEVER-admitted runs are bounded by the cap PLUS the abort overflow`;
  `F2/round 4/round 5: the budget cap refuses new runs and never evicts a live
  record`; `best effort residual: with the budget and its abort overflow full, an
  abort records nothing and evicts no live record; its next callback is admitted
  once room frees`.
- **A failed or aborted run does not capture again while its record is retained**,
  for at least `tombstoneMinAgeMs`: a late callback is dropped, never re-admitted,
  and no new write starts after the abort — one already in flight may still land,
  and once `gateway_stop` has run nothing is admitted at all —
  `F1 (round 10): a callback just before tombstoneMinAgeMs after the abort is
  still dropped`; `F1: a callback after an abort is dropped even after a later
  sweep`; `item 5 (mutation: abort dropped): a failed agent_end starts no new
  write and discards a late result`; `item 5(a2): a later callback after a
  model_call_ended abort is dropped, with no new write`; `item 5(b2): a later
  callback after gateway_stop is dropped, with no new write`; `round 13
  (mutation: stop flag not checked): after gateway_stop a late llm_output for an
  aborted run admits no record and starts no write`; `round 13 guard: after
  gateway_stop an abort for a run the registry never saw inserts no record`.
  Past the overflow bound this is best effort:
  with the budget and its abort overflow both full, the abort of a never-admitted
  run records nothing, so that run's next callback can capture again and start a
  write — `(c) with the budget AND its abort overflow full, an abort records
  nothing and logs once`; `best effort residual: with the budget and its abort
  overflow full, an abort records nothing and evicts no live record; its next
  callback is admitted once room frees`.
- **Log lines about refused or dropped callbacks are rate-limited, not guaranteed
  to appear exactly once** — `R3 (round 10, extended round 11): refusal lines are
  rate-limited — ONE line per key, however many callbacks arrive`; `F2: the
  one-time-log set is bounded`.

The mechanics behind these bounds — which callbacks capture and sweep, the
one-time-log set, the record phases, the removal predicate and the admission
order — live beside the code in `index.ts` and in the tests named above.

A capture whose run id is within the server's `hostSource` id grammar carries it
as the memory's **`hostSource`** (`{ host: "openclaw", kind: "run", id: <run id> }`,
the host's run id as sent, never derived from captured text; Flair stores its
NFC-normalised form), plus the host's session
id when the hook carries one. A run id outside that grammar is omitted with a
rate-limited warning — the capture still lands. `hostSource` is the writer's claim, not
verified host authorship. Covered by
`test/integration/host-source-openclaw-capture-1940.test.ts`; the session-keyed
`agent_end` capture reads back from a real Flair component in
`test/integration/agent-end-session-capture-2560.test.ts`.

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
