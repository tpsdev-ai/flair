# REM — reflection, distillation, and review

REM (Reflect · Extract · Merge) is Flair's memory-curation cycle: it reads an agent's recent memories, distills them into candidate insights, and stages those candidates for explicit human/agent review — nothing is auto-promoted except the narrow ADK per-user path (see [Auto-promote](#auto-promote-adk-only)). `flair rem rapid` runs it on demand; `flair rem nightly enable` runs it on a schedule. See [`docs/notes/rem-ux.md`](notes/rem-ux.md) for the full trigger model, locality guarantees, and the review-loop UX this page's commands feed into.

> **⚠️ Prerequisite: a configured generative backend.** All REM commands (`rapid`, `nightly`, `candidates`, `promote`, `reject`) require Harper's `models.generate()` to be wired — without it, REM calls fail with `Reflection error: No generative backend configured`. Set up a backend first (see [Configuration](#configuration) below) before running any REM command. The fastest path is Ollama with a non-thinking model, which needs zero credentials and keeps all traffic local.

## Configuration

Distillation runs **server-side**, via Harper's model-access API (`models.generate()`). Flair ships zero provider code — which backend answers a REM call is entirely a Harper `models:` configuration decision.

The `models:` block goes in **Harper's root instance config** (`harper-config.yaml` / `harperdb-config.yaml` at the Harper data directory) — **not** in flair's own `config.yaml` component config, which Harper only loads as a non-root component config and never reads a `models:` block from.

**Local Ollama (zero-key default):**

```yaml
# harper-config.yaml
models:
  generative:
    default:            # unset FLAIR_REM_MODEL resolves to this logical name
      backend: ollama
      host: localhost:11434   # optional — already the default
      model: llama3.1         # required — Ollama has no built-in default model
```

No credentials, nothing leaves the box (see the warning below).

> **⚠️ Pick a non-thinking model for the Ollama backend.**
> Thinking/reasoning models (`qwen3-next`, `deepseek-r1`, and similar) currently return **empty generations** through Harper's Ollama backend: Ollama routes their output into the response's `thinking` field, which the backend doesn't read, so every REM execute run fails closed with `distillation_failed` (no candidates are ever staged — the failure is availability, not correctness). Use a non-thinking model (`llama3.1`, `qwen3-coder-next`, `gemma3`, …) until the upstream backend behavior changes. Tracked in #712.

**Hosted provider** (OpenAI / Anthropic / Bedrock also supported — `backend: openai|anthropic|bedrock`):

```yaml
# harper-config.yaml
models:
  generative:
    hosted:
      backend: openai
      apiKey: ${OPENAI_API_KEY}   # env-var indirection — never a literal key in YAML
      model: gpt-4o-mini
```

A literal (non-`${VAR}`) `apiKey` in the config file is flagged at Harper boot — keep it out of the YAML on disk. On Fabric / managed deploys, the env var itself is provisioned through Harper's Fabric secrets mechanism, which encrypts the value at rest (`enc:v1:` storage format) rather than holding it in plaintext; consult Harper's Fabric secrets documentation for provisioning that env var. Flair's own [`docs/secrets-and-keys.md`](secrets-and-keys.md) covers Flair's Ed25519 agent identity and general client-side credential patterns, but does not cover this Harper-side mechanism.

> **⚠️ Data egress is a configuration decision.**
> Pointing `models:` at a hosted provider (OpenAI, Anthropic, Bedrock, or any other network backend) sends the memory content being reflected on to that provider. A local Ollama backend keeps everything on the box — nothing transits the network. Default posture: local. Choose a hosted backend deliberately, and know what leaves when you do.

### `FLAIR_REM_MODEL`

Selects which `models.generative.<logicalName>` entry a REM call uses. Unset → Harper's default routing (the `default` logical name above). Set it to route to a different registered backend, e.g. `FLAIR_REM_MODEL=hosted`.

### Clustered deploys — nightly enable is per-node, deliberately

`flair rem nightly enable` installs a platform-native timer (launchd / systemd) **on the host it runs on**. In a multi-node or Fabric deploy, enabling it on every node would run the cycle N times and scatter N sets of pre-cycle snapshots. The v1 rule: **exactly one node gets the timer** — pick it deliberately, the same way you'd pick a cron owner for any single-writer job. This is a v1 constraint, not a permanent one; see #709 for the roadmap toward a coordinated multi-node story.

Snapshot locality follows from this: a nightly cycle's pre-run snapshot (`~/.flair/snapshots/<agent>/`) lands on **the node that ran that cycle** — `flair rem restore <date>` and `flair rem snapshot list` only see local snapshots. If you move which node owns the timer, snapshot history doesn't move with it.

## Interactive vs nightly

- **Interactive (`flair rem rapid`):** one bounded, synchronous distillation call — gather cap 50 memories, bounded output tokens, seconds not minutes. Executes by default, staging candidates and printing a summary; `--prompt-only` returns the reflection prompt instead, for the bring-your-own-model handoff.
- **Nightly (`flair rem nightly enable` / `run-once`):** fully detached — the scheduler runs the full cycle (snapshot → maintenance → distillation), candidates land as pending rows, and an audit row lands in `~/.flair/logs/rem-nightly.jsonl`. The operator reviews in the morning via `flair rem candidates`.

Either path, the review loop is the same: `flair rem candidates` lists pending rows, `flair rem promote <id> --rationale "<why>"` / `flair rem reject <id> --reason "<why>"` decide them. Nothing self-promotes except the narrow ADK per-user path ([Auto-promote](#auto-promote-adk-only)) — see [`docs/notes/rem-ux.md`](notes/rem-ux.md) for why that gate is load-bearing and how the surface is expected to evolve.

### ADK agents — per-user (per-tag) distillation

adk-flair collapses every `(app, user)` into **one** Flair agentId, separating users only by a per-user tag `adk:<app>:<user>`. Distilling such an agentId with the default `scope:"recent"` would mix every user's sessions into shared claims — cross-user bleed. The nightly cycle therefore detects the agent's active `adk:<app>:<user>` tags (from the memories it already loads for the snapshot, with a recency cutoff that skips idle users and is scoped to the agent's own records) and runs distillation **once per tag** under `scope:"tagged"`, so each user's candidates come only from that user's own sessions. Agents with no `adk:` tags distill agentId-wide exactly as before.

A candidate distilled under a tag records that tag in its `scopeTag` field. `flair rem promote` reads `scopeTag` as the authoritative per-user lineage tag and propagates it onto the promoted memory — so the promoted claim stays in that user's retrieval scope even if the source episodes are later archived or deleted. The single-node timer rule above is unchanged; the per-tag loop runs inside the one cycle on the one node. The non-thinking-model requirement (above) still holds — the per-tag path calls the same `models.generate()` route.

#### Auto-promote (ADK only)

For ADK agents, the nightly cycle **auto-promotes** these `scopeTag`-bearing candidates to the user's own persistent memory immediately after distillation — the one place REM does not wait for a human `rem promote`. The safety argument is blast-radius, not identity: the claim is distilled from a user's own sessions into that same user's own tag scope, so no cross-agent or Soul trust boundary is crossed. The promotion is enforced entirely server-side (`POST /AutoPromoteCandidates`), never by a CLI flag a compromised agent key could flip, and holds four invariants:

- **Memory only, never Soul.** The target is hard-locked to `memory`; there is no Soul code path (Soul is agentId-scoped and cannot carry a per-user tag, so an ADK-sourced Soul promotion would be cross-user by construction).
- **Fail-closed tag lineage.** A candidate is promoted only if it carries an authoritative `adk:<app>:<user>` scope tag, which the promoted memory then carries. The promoted memory is written `visibility:"private"` (owner-only) — not the org-open `shared` default a `persistent` write would otherwise get — so it is reachable only through the app agent's own tag-filtered search (which re-verifies the tag), invisible both to another user's tag filter and to every other agent on the instance. A candidate whose scope tag is absent or blank is left pending, never promoted tagless into the shared agentId namespace.
- **Content-safety, strict.** The claim is scanned for prompt injection and refused on a flag regardless of `FLAIR_CONTENT_SAFETY` — an unattended write does not fall back to warn-and-tag.
- **Non-impersonating reviewer.** The promoted memory and its candidate record `machine:adk-auto-promote`, never a value mistakable for a human or agent reviewer.

Anything ineligible (no scope tag, flagged content, already decided) is left pending for the human `rem promote` path. The step is bounded per cycle and non-fatal; `flair rem nightly run-once` reports the count auto-promoted. **Non-ADK candidates never auto-promote** — the human review gate below is unchanged for them.
