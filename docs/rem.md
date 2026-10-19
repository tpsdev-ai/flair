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

Snapshot locality follows from this: a nightly cycle's pre-run snapshot (`~/.flair/snapshots/<agent>/`) lands on **the node that ran that cycle** — `flair rem restore <date>` and `flair rem snapshot list` only see local snapshots. If you move which node owns the timer, snapshot history doesn't move with it. Live replay (`flair rem restore <date> --apply`) rewrites Soul with operator credentials (`--admin-pass` / `--admin-pass-file`); an agent key is refused. Leftover MemoryCandidate rows for that agent are deleted first so their claim text cannot block Soul restore.

## Interactive vs nightly

- **Interactive (`flair rem rapid`):** one bounded, synchronous distillation call — gather cap 50 memories, bounded output tokens, seconds not minutes. Executes by default, staging candidates and printing a summary; `--prompt-only` returns the reflection prompt instead, for the bring-your-own-model handoff. A cold generative backend (first Ollama model load) is warmed outside Harper's request transaction so execute fails as the documented 502/503, not HTTP 422 from the 30s open-transaction ceiling.
- **Nightly (`flair rem nightly enable` / `run-once`):** fully detached — the scheduler runs the full cycle (snapshot → maintenance → distillation), candidates land as pending rows, and an audit row lands in `~/.flair/logs/rem-nightly.jsonl`. The operator reviews in the morning via `flair rem candidates`.

### Nightly admin credential

`flair rem nightly enable` bakes the absolute path of the admin-password file into the scheduler shim (`~/.flair/admin-pass` by default; override with `--admin-pass-file`). `run-once` reads the password from that file at run time; the value is never stored in the shim, exported into the environment, or passed in argv. The instance-wide dedup-cluster step calls an admin-gated route, so the file must exist and be owner-only (no group or world permission bits; `flair init` writes mode 0600). When the shim names a file that is missing, empty, or group-/world-readable, the run fails at startup before any cycle work with the dedup step NOT RUN, names the path and the remedy, and exits nonzero on every path, including a paused cycle and a dry run. An existing install picks up the new shim by re-running `flair rem nightly enable`; until then the previously installed shim stays in place.

The pending-candidate count `run-once` prints (`Pending:`) uses the same credential through the operations API. When that query fails, the line reads `Pending: unknown (<reason>)`, the failure is listed under `Errors:`, and the run exits nonzero. With no admin credential, when the cycle reaches the candidate-count step, the line reads `Pending: unknown (no admin credential for the operations API)`.

### Safety bounds (a large backlog must not take the instance down)

A first run over thousands of unreflected memories used to hold the Harper main thread long enough that `/Health` and search timed out. Nightly distillation is now bounded:

- **Refuse to start** when `GET /Health` cannot be served within 2 seconds. The cycle logs `status: "refused"` and prints the reason; the scheduler will try again next night. Restore `/Health` before retrying, or `flair rem pause` to stop the timer.
- **Per-run cap** — at most 50 memories per `/ReflectMemories` call (`FLAIR_REM_MAX_MEMORIES`, hard ceiling 200), oldest-unreflected first so a 3k backlog drains across nights instead of one blocking run. Already-reflected rows fill leftover slots only when fewer than N unreflected matches remain. Nightly uses `scope: "all"` for ordinary (non-ADK) agents so the cap sees the whole backlog, not only the last 24 hours.
- **Yield + abort** — the gather scan yields so `/Health` and reads keep serving. `flair rem pause` (or `flair rem abort`) writes `~/.flair/rem.paused`; an in-flight gather on the same host stops at the next yield without restarting Harper.

`flair rem rapid` uses the same gather cap, oldest-unreflected selection, yield, and abort checks. It still defaults to `scope: "recent"` (last 24 hours) unless you pass `--since` / a wider scope.

Either path, the review loop is the same: `flair rem candidates` lists pending rows, `flair rem promote <id> --rationale "<why>"` / `flair rem reject <id> --reason "<why>"` decide them. Nothing self-promotes except the narrow ADK per-user path ([Auto-promote](#auto-promote-adk-only)) — see [`docs/notes/rem-ux.md`](notes/rem-ux.md) for why that gate is load-bearing and how the surface is expected to evolve.

### ADK agents — per-user (per-tag) distillation

adk-flair collapses every `(app, user)` into **one** Flair agentId, separating users only by a per-user tag `adk:<app>:<user>`. Distilling such an agentId with the default `scope:"recent"` would mix every user's sessions into shared claims — cross-user bleed. The nightly cycle therefore detects the agent's active `adk:<app>:<user>` tags (from the memories it already loads for the snapshot, with a recency cutoff that skips idle users and is scoped to the agent's own records) and runs distillation **once per tag** under `scope:"tagged"`, so each user's candidates come only from that user's own sessions. Agents with no `adk:` tags distill agentId-wide exactly as before.

Memory promotion runs through `POST /PromoteMemoryCandidate` with `candidateId` and a nonempty `rationale`. The server reads the candidate and its lineage, writes the persistent memory through the normal safety/provenance path, and stamps `promotionStatus`, `promotedAt`, `promotedBy` and `promotionContentHash` (a server-only SHA-256 of the stored, post-redaction content at stamping time). Successful stamps bind newly created memories. Legacy verdicts without a matching binding are suppressed by binding-checked readers; review creates a new memory rather than binding the legacy row. When the automatic stamp reports failure, the candidate stays pending and the sweep reports `stamp_refused`. Direct Memory writes cannot set these workflow fields, including administrator REST writes; a content-changing write clears them. Full-row updates may echo unchanged stamps; omitted stamps are preserved. Creating a successor with `memory_update(preserveHistory=true)` leaves the verdict on the predecessor; the new content starts without an approval stamp. Non-admin reviewers are attributed to their authenticated identity; only administrators may name another reviewer. `flair rem promote --to memory` uses this endpoint and requires an updated server; it does not fall back to direct verdict writes.

A candidate distilled under a tag records that tag in its `scopeTag` field. `flair rem promote` reads `scopeTag` as the authoritative per-user lineage tag and propagates it onto the promoted memory — so the promoted claim stays in that user's retrieval scope even if the source episodes are later archived or deleted. The single-node timer rule above is unchanged; the per-tag loop runs inside the one cycle on the one node. The non-thinking-model requirement (above) still holds — the per-tag path calls the same `models.generate()` route.

#### Auto-promote (ADK only)

For ADK agents, the nightly cycle **auto-promotes** these `scopeTag`-bearing candidates to the user's own persistent memory immediately after distillation — the one place REM does not wait for a human `rem promote`. The safety argument is blast-radius, not identity: the claim is distilled from a user's own sessions into that same user's own tag scope, so no cross-agent or Soul trust boundary is crossed. The promotion is enforced entirely server-side (`POST /AutoPromoteCandidates`), never by a CLI flag a compromised agent key could flip, and holds four invariants:

- **Memory only, never Soul.** The target is hard-locked to `memory`; there is no Soul code path (Soul is agentId-scoped and cannot carry a per-user tag, so an ADK-sourced Soul promotion would be cross-user by construction). Soul mutations require operator credentials and refuse values matching any stored Memory or MemoryCandidate. This also prevents scripted promotion of learned claims, regardless of connector. See [Soul authorship](auth.md#soul-authorship).
- **Fail-closed tag lineage.** A candidate is promoted only if it carries an authoritative `adk:<app>:<user>` scope tag, which the promoted memory then carries. The promoted memory is written `visibility:"private"` (owner-only) — not the org-open `shared` default a `persistent` write would otherwise get — so it is reachable only through the app agent's own tag-filtered search (which re-verifies the tag), invisible both to another user's tag filter and to every other agent on the instance. A candidate whose scope tag is absent or blank is left pending, never promoted tagless into the shared agentId namespace.
- **Content-safety, strict.** The claim is scanned for prompt injection and refused on a flag regardless of `FLAIR_CONTENT_SAFETY` — an unattended write does not fall back to warn-and-tag.
- **Non-impersonating reviewer.** The promoted memory and its candidate record `machine:adk-auto-promote`, never a value mistakable for a human or agent reviewer.

Anything ineligible (no scope tag, flagged content, already decided) is left pending for the human `rem promote` path. The step is bounded per cycle and non-fatal: the per-call `limit` caps the eligible candidates the sweep writes a memory for, whatever the write's outcome, plus those it takes an earlier recorded memory for (below); the rest stay pending for a later cycle. `flair rem nightly run-once` reports the count auto-promoted. **Non-ADK candidates never auto-promote** — the human review gate below is unchanged for them.

The sweep writes and stamps the promoted memory, then marks the candidate `promoted`; it does not mark a candidate promoted before its memory is stamped. A failure in between leaves a pending candidate whose memory is already written. (A concurrent deletion of that memory is still possible.) `POST /AutoPromoteCandidates` answers `{ agentId, promoted, skipped, incomplete, unconfirmed, count, considered }`:

- `promoted`: the memory id of each candidate this call marked `promoted`. `count` is its length.
- `skipped`: `{ id, reason }` for each candidate left pending without a promotion, for example `no_adk_scope_tag`, `content_safety:…`, `memory_write_error`, `stamp_refused` or `recorded_row_changed`.
- `incomplete`: `{ memoryId, candidateId, error }` for each promotion whose memory was written and stamped but whose candidate update threw, when a fresh read of the candidate then found it `pending`.
- `unconfirmed`: `{ memoryId, candidateId, error, readBack }` for the same failure when that read failed, or found the candidate neither `pending` nor promoted with this memory; `readBack` says which. When the read finds the candidate promoted with this memory and reviewer, the update did land and the candidate is listed under `promoted`.
- `considered`: the number of pending candidates the call examined.

Neither `incomplete` nor `unconfirmed` entries count in `promoted` or `count`; their memory writes do count toward the `limit`.

A later sweep re-reads a still-pending candidate. It can use the memory recorded on the candidate (`promotedRowId`, `promotedRowInstanceToken`) only when that identity was recorded: the sweep records it before the stamp, and when that recording also failed, the next sweep attempts a fresh write instead. The recorded memory must still be the one the sweep wrote (same id and incarnation token, same owner, content equal to the claim, the sweep's visibility, durability and tags, not archived). When it also carries the sweep's own approval — `promotionStatus` `approved`, `promotedBy` `machine:adk-auto-promote`, a `promotionContentHash` that matches its content, and a `promotedAt` — the sweep adopts it. It takes the memory's write lock, re-checks all of this on a fresh read, and, still holding the lock, marks the candidate `promoted` with `decidedAt` set to the memory's `promotedAt`. It writes no other memory and reports that memory id under `promoted`. An owner edit that lands before the lock leaves the candidate pending (`recorded_row_changed`). One that waits for the lock lands after the candidate update, and clears the approval the same way an edit to any promoted memory does. Memory's dedup gate only reports a near-duplicate, so this check is what prevents the second row. When the recorded memory does not qualify (for example, a different verdict, edited content, or archived), the sweep attempts a fresh write and stamp, either of which can fail or be refused. The approval check trusts Flair's resource write paths, where verdict fields are server-written; the admin operations API writes rows directly and can change them. `flair rem nightly run-once` prints the incomplete and unconfirmed counts on its `Auto-promoted:` line.

## Memory retention and deletion

Durability is owner-controlled, including `permanent`: owners may create, change, archive and delete their own memories at every tier. Administrators may delete any owner’s memory. The permanent tier controls retention and bootstrap priority; it does not prevent an explicit owner deletion.

What each tier actually guarantees:

- permanent — routine maintenance never reaps or age-archives it (an expired validTo archives an eligible row; an acquired expiresAt never reaps it); it never decays; bootstrap considers the bootstrapping agent's own permanent memories before recent rows, subject to scope, expiry/closure and the token budget.
- persistent — routine maintenance never reaps or age-archives it (an expired validTo archives an eligible row; an acquired expiresAt never reaps it).
- standard — routine maintenance archives it once its validTo passes or, as a session note, after 30 days.
- ephemeral — routine maintenance reaps it once its TTL (24h by default) passes.
- No tier adds a flush, fsync, backup or replica acknowledgement: an explicit delete (owner or admin) or a store failure can end any of them.

Soul is operator-authored identity, not a promotion target for learned candidates. `flair rem promote --to soul` is refused for stored candidate text even with operator credentials; promote learned claims to Memory instead.
