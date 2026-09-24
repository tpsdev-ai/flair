# openclaw-flair — real-host drills (slice 1)

These drills exercise the identity core against a **real OpenClaw host**. They
are not an in-memory mock: the unit mock replays what these drills record.

## Host this is written for

- **Tested host versions: `2026.8.1`** (the K&S VMs) and **`2026.9.6`** (npm
  `latest`). The runner reads the host version from the host itself
  (`openclaw --version`) and **refuses to run unless it is one of the tested
  versions** — the point of the drill is the host contract. It never sets a
  version environment variable; the plugin's version source is the host API
  (`api.runtime.version`), which an env var cannot influence.

## The config it loads

The runner writes a throwaway `HOME` with:

- `openclaw.json` — the plugin at id `openclaw-flair` in the **memory** slot
  (`plugins.slots.memory = "openclaw-flair"`, **no** `contextEngine` slot), one
  agent, and `hooks.allowPromptInjection` / `hooks.allowConversationAccess` set
  per drill (drill 4 flips them **off**).
- `keys/<agent>.key` — a 32-byte Ed25519 seed per agent,
  `~/.flair/keys/<agent>.key` layout, mode `0600`.
- A Flair base URL from `FLAIR_URL` (or `http://127.0.0.1:19926`); a Flair
  instance must be reachable and have the agents registered.

`HOME` isolation is mandatory: the runner sets `HOME` to the temp dir so no real
`~/.flair` (which on some hosts is production) is touched.

## What each drill asserts

1. **happy** — with the plugin enabled, one agent turn completes and reaches the
   provider; the returned prompt context is present in what the model received;
   a `memory_store` is recorded under the **serving** agent; zero Soul writes.
2. **decline** — with a deliberately falsified tested set (forcing the
   out-of-set branch), one turn completes and reaches the provider, there are no
   `[plugins]` warnings, and the line
   `openclaw-flair disabled: host <v> not in tested set <s>` appears.
3. **two-agents** — on one real gateway, A's turn never signs as B and vice
   versa (asserted from the signer id in the Flair request log).
4. **gates** — capture permission withheld → `capture disabled (permission)` and
   zero capture writes; prompt policy withheld → `prompt context disabled: policy`.
5. **transcript** — the raw host output (hooks accepted, permission-gate
   behaviour, event order, including whether `agent_end` still precedes
   `llm_output`) is recorded to `transcript-<hostVersion>.json` for the mock to
   replay.

## Running

```bash
# on a tested-version host, with a reachable Flair instance:
HOME=/tmp/ocf-drill node packages/openclaw-flair/scripts/drill/run.mjs
```

The runner shells out to the host CLI (`OPENCLAW_BIN`, default `openclaw`) —
`openclaw --version` to learn the host version, and `openclaw agent run` for a
one-shot turn; the exact invocation is isolated in `HOST_INVOKE` in `run.mjs` so
a host that needs different flags only touches one line. Drill 2 (decline)
builds a falsified copy of the plugin's built entry whose tested set excludes the
real host version — that is the only way to force the out-of-set branch now that
the version comes from the host API.

## Status

These drills are **unvalidated in the authoring environment** (no
`2026.8.1`/`2026.9.6` host was available). They are delivered for the K&S host to
run after the PR is up, per the slice-1 plan. The `contracts.tools` warning on
`2026.8.1` (spec §2) is a known open item: a minimal repro is in the PR body.
