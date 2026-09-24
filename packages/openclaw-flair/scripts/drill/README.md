# openclaw-flair — drill scaffolding (slice 1)

**This is not a working drill suite.** `run.mjs` sets up an isolated scratch
HOME, learns the host version from the host CLI, and drives **one embedded agent
turn per step**, recording the host's output. It does **not** assert the
properties the spec's drills require. It is scaffolding for a tested host to
finish; see the TODO.

## What `run.mjs` actually does

For each step it:

- mkdtemps a **fresh private** scratch HOME (a caller-supplied HOME is never
  accepted — a symlink planted at a predictable path could otherwise make the
  runner overwrite a real `~/.openclaw` / `~/.flair/keys`);
- writes `openclaw.json` with the plugin at id `openclaw-flair` in the **memory**
  slot (no `contextEngine` slot) and two agents, `agent-a` and `agent-b`;
- writes a 32-byte Ed25519 seed at `.flair/keys/<agent>.key` (mode `0600`) — **not
  registered with any Flair instance**;
- runs `openclaw agent --local --agent <id> --message <text>` with a **filtered**
  environment (no ambient `OPENCLAW_*` / `FLAIR_*`);
- records PASS/FAIL for a single substring check on the host output (see the
  table below);
- removes every scratch HOME on exit.

It refuses to run unless invoked with `--local` (or `--embedded`), with no
`OPENCLAW_GATEWAY_*` in the environment, and on a host whose version is in the
tested set.

| Step | The ONE thing it checks today |
|---|---|
| happy | exit is 0 and the output does not say `openclaw-flair disabled` |
| decline | (falsified built entry) the output says `not in tested set` and has no `[plugins]` warnings |
| two-agents | exit is 0 (requires per-agent OS users; on a shared user the plugin declines) |
| gates-capture | `capture disabled (permission)` appears |
| gates-prompt | `prompt context disabled: policy` appears |
| transcript | writes `transcript-<hostVersion>.json` (raw stdout/stderr) |

## TODO — what a real-host run must add (numbered)

1. **Register the keys with Flair** (`flair agent add` per agent) so the plugin
   can actually sign; today the seeds are never registered.
2. **Happy path:** assert the returned prompt context is present in what the
   model received, that a `memory_store` was recorded under the **serving**
   agent, and that the turn made **zero Soul writes**.
3. **Decline:** assert no `[plugins]` warnings AND the exact disabled line, and
   that the turn still completes and reaches the provider.
4. **Two agents:** assert A's turn never signs as B and vice versa, read from the
   signer id in the Flair request log — on a host with per-agent OS users.
5. **Gates:** assert zero capture writes when capture is withheld (not just the
   status line).
6. **Transcript:** capture the hook order the host actually used (including
   whether `agent_end` precedes `llm_output`), the hooks the host accepted, and
   the permission-gate behaviour, then replay that transcript in the unit mock.
7. **Re-capture the transcript on every host-version bump**, and add the version
   to `TESTED_HOST_VERSIONS` only with a deliberate change that re-runs these.

## Running

```bash
node packages/openclaw-flair/scripts/drill/run.mjs --local
```

Requires a host in the tested set and a reachable Flair instance
(`FLAIR_URL`). Not to be run against a live gateway.
