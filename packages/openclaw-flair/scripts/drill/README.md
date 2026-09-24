# openclaw-flair — real-host drill plan (slice 1)

There is **no runner in this PR**: it cannot run without a tested host, and a
runner that cannot satisfy its own assertions is worse than none. This is the
**plan** the runner must implement, on a tested host, in a separate change.

## Host

The drills run against a **real OpenClaw** whose version is in the plugin's
tested set (`2026.8.1`, `2026.9.6`). The runner must learn the version from the
host itself (`openclaw --version`), never from an environment variable — the
plugin's version source is the host API (`api.runtime.version`), which an env var
cannot influence.

## What each drill asserts

1. **happy path** — with the plugin enabled, one agent turn completes and reaches
   the provider; the returned prompt context is present in what the model
   received; a `memory_store` is recorded under the **serving** agent; zero Soul
   writes.
2. **decline** — with a deliberately falsified tested set (forcing the out-of-set
   branch), one turn completes and reaches the provider, there are no `[plugins]`
   warnings, and the line `openclaw-flair disabled: host <v> not in tested set <s>`
   appears.
3. **two agents** — on one real gateway, A's turn never signs as B and vice versa.
   The two agents must be under **separate OS users** (or run on separate
   gateways): the shared-OS-user gate refuses a same-user pair **by design**, so a
   single-user host cannot pass this drill.
4. **gates** — capture permission withheld → `capture disabled (permission)` and
   zero capture writes; prompt policy withheld → `prompt context disabled: policy`.
5. **transcript** — record what the host accepted (hooks, permission-gate
   behaviour, event order, including whether `agent_end` precedes `llm_output`),
   and replay that transcript in the unit mock; re-capture it on every host bump.

## TODO — what the runner must add

1. **Register the keys with Flair** (`flair agent add` per agent) so the plugin
   can actually sign.
2. **Happy path:** assert the returned prompt context is present in what the model
   received, that a `memory_store` was recorded under the **serving** agent, and
   that the turn made **zero Soul writes**.
3. **Decline:** assert no `[plugins]` warnings AND the exact disabled line, and
   that the turn still completes and reaches the provider.
4. **Two agents:** assert A's turn never signs as B and vice versa, read from the
   signer id in the Flair request log — with the two agents under separate OS
   users.
5. **Gates:** assert zero capture writes when capture is withheld (not just the
   status line).
6. **Transcript:** capture the hook order the host actually used, the hooks the
   host accepted, and the permission-gate behaviour; replay it in the unit mock.
7. **Safety:** a fresh private scratch HOME per run (never a caller-supplied
   HOME), an embedded/`--local` invocation only (never a live gateway), a filtered
   child environment, and removal of the scratch HOME on exit.
8. **Re-capture the transcript on every host-version bump**, and add a version to
   `TESTED_HOST_VERSIONS` only with a deliberate change that re-runs these.
