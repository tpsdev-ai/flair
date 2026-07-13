# REM — reflection, distillation, and review

REM (Reflect · Extract · Merge) is Flair's memory-curation cycle: it reads an agent's recent memories, distills them into candidate insights, and stages those candidates for explicit human/agent review — nothing is ever auto-promoted. `flair rem rapid` runs it on demand; `flair rem nightly enable` runs it on a schedule. See [`docs/notes/rem-ux.md`](notes/rem-ux.md) for the full trigger model, locality guarantees, and the review-loop UX this page's commands feed into.

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

Either path, the review loop is the same: `flair rem candidates` lists pending rows, `flair rem promote <id> --rationale "<why>"` / `flair rem reject <id> --reason "<why>"` decide them. Nothing self-promotes — see [`docs/notes/rem-ux.md`](notes/rem-ux.md) for why that gate is load-bearing and how the surface is expected to evolve.
