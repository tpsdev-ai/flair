# Changelog

## [Unreleased]

Entries for the next release live as **fragment files** under [`.changelog/unreleased/`](.changelog/unreleased/) —
one file per change, so two pull requests never edit the same lines and never conflict here.

Add `.changelog/unreleased/<category>-<slug>.md` containing your entry exactly as it should read
under its `### Category` heading, leading `- ` included. Categories: `added`, `changed`,
`deprecated`, `removed`, `fixed`, `security`.

```bash
node scripts/changelog-fragments.mjs render   # preview the assembled section
node scripts/changelog-fragments.mjs check    # what CI checks
```

`scripts/release.sh` assembles them into a `## [X.Y.Z]` section and deletes them as part of the
version cut. **Do not add entries to this section by hand** — the release step replaces its body,
so a hand-written entry here is lost.

## [0.44.11] - 2026-08-16

### Added

- **ADK-distilled session claims are now auto-promoted to the user's own
  memory, unattended.** After the per-user nightly distillation (#1205b-1)
  stages `MemoryCandidate`s each carrying an `adk:<app>:<user>` scope tag, the
  nightly cycle promotes the eligible ones to persistent memory server-side via
  a new `POST /AutoPromoteCandidates` resource — no human `rem promote` step for
  this narrow path. It runs only for ADK agents (an agentId with active `adk:`
  tags), is bounded per cycle, and is non-fatal (a failure is recorded and the
  candidates stay pending). Non-ADK candidates are unchanged: they still require
  the human `rem promote`. `flair rem nightly run-once` reports the count
  auto-promoted. Refs #1205 (completes the feature).

- **`bootstrap` now explains WHY any empty structured container is empty.** An
  empty `events: []` was byte-indistinguishable from the 0.44.8 regression where
  events were silently dropped — a connector could only tell the difference by
  diffing against a previous payload (flair#1182). The self-describing rule that
  already covered `predicted` is now applied across the containers: when a
  container ships empty the payload carries a short hint naming the reason and
  what fills it — `eventsHint`, `teammateFindingsHint` (alongside the existing
  `predictedHint`) — present only when that container is empty, so a healthy
  payload is unchanged. With `includeTrust: true`, a trust entry whose
  `matchQuality` is `null` now carries a `matchQualityNote` saying why: on the
  lifecycle sections (`permanent`/`recent`/`predicted`) a null band is correct —
  those are a window load, not a retrieval surface — not a scoring failure on
  your own records (flair#1225, documented in `docs/mcp-clients.md`).

- **LongMemEval_s end-to-end benchmark (Layer 2).** A new `flair-bench`
  harness (`test/bench/longmemeval/`) that ingests each LongMemEval_s question's
  multi-session history into real Flair, retrieves via Flair's real BM25+RRF
  retrieval, has a pinned reader answer, and has a pinned local judge grade it —
  across four arms (flair, vector-only, full-context, no-context). Everything is
  pinned for local reproducibility: the dataset (HF commit + sha256), the judge
  and reader (Ollama manifest digests), num_ctx, retrieval config, and the exact
  grading prompts — all folded into a content-addressed run artifact. Judge and
  reader run locally via Ollama, so anyone re-runs the exact number with no
  external API key or spend. The harness produces numbers; publishing one is a
  separate, gated human decision recorded against the artifact hash. Repo-
  internal tooling — not part of the published `@tpsdev-ai/flair-bench` package.

### Fixed

- **`bootstrap` over the /mcp connector now respects `maxTokens` when teammate
  findings are present.** The token budget charged each memory and teammate
  finding its short *prose* line, but on the connector path (where the prose
  `context` is a pointer) it is the heavier *structured* container object that
  actually ships — and that object is what `tokenEstimate` measures. Teammate
  findings, which carry an id, two timestamps and a source, ran well over their
  prose line, so several rode outside the enforced budget: a `maxTokens: 4000`
  bootstrap could serialize at ~5300 (+33%) with no org events involved
  (flair#1199). The selector now charges each item what it actually ships on the
  requested surface — the structured object on the connector path, the prose line
  on the REST/CLI prose path (which keeps its 0.44.6 selection capacity, flair#1207
  unchanged) — so a connector's payload stays within `maxTokens` plus a small,
  fixed JSON-scaffolding tolerance. A teammate-heavy conformance fixture now makes
  the budget-cap invariant catch this class (it fails if the fix is reverted).

- **Golden-path smoke suite no longer flakes on a cold-start embedding
  timeout.** The embedding backend loads its model lazily on the first embed
  call, and `/Health` returning 200 does not mean that load has finished — so on
  a cold or loaded CI runner the first timed write (Step 2) could pay the model
  load and exceed `writeMemory`'s 10s client abort, surfacing as
  `TimeoutError: The operation timed out` at ~10s (flair#1219, seen across
  #1217/#1221/#1222). The suite now warms the embedding model in `beforeAll` via
  a throwaway agent+memory write with a generous budget, so the measured
  golden-path write is always a warm write. Test-only: production
  `writeMemory`'s 10s timeout is unchanged.

### Security

- **Unattended ADK auto-promote enforces four authz invariants server-side.**
  Because auto-promotion (see Added) removes the human reviewer that also
  guarded content and scope, the `AutoPromoteCandidates` resource enforces, in
  the server layer (never a flippable CLI flag): (1) the target is hard-locked
  to `memory` — there is no Soul code path, and an explicit non-memory target is
  refused, so an ADK-sourced claim can never land in the agentId-scoped Soul
  (cross-user by construction); (2) tag lineage is fail-closed — a candidate is
  promoted only if it carries an authoritative `adk:<app>:<user>` scope tag,
  which the promoted memory then carries, and the promoted memory is written
  `visibility:"private"` (owner-only) — NOT the `shared` (org-open) default a
  `persistent` write would otherwise get, which would make the distilled private
  session claim readable by every agent on the instance. So a claim is
  retrievable only through its own app agent's tag-filtered search (which
  re-verifies the tag), invisible both to another user's tag filter and to any
  other agent; a tagless promotion into the shared agentId namespace is refused,
  not written; (3) the claim is
  content-safety scanned strict — a prompt-injection payload is never
  auto-promoted regardless of `FLAIR_CONTENT_SAFETY`; (4) the promoted memory
  and its candidate record a reserved `machine:adk-auto-promote` reviewerId,
  never mistakable for a human or agent reviewer. A non-admin caller can sweep
  only its own candidates. Refs #1205.

## [0.44.10] - 2026-08-16

### Added

- **REM nightly distillation is now per-user (per-tag) for ADK agents.**
  adk-flair collapses every `(app, user)` into one Flair agentId, separating
  users only by an `adk:<app>:<user>` tag; the nightly runner previously
  distilled per-agentId (`scope:"recent"`), mixing every user's sessions into
  shared claims (cross-user bleed). The cycle now derives the active
  `adk:<app>:<user>` tags for the agent (from the memories it already fetches
  for the snapshot — no extra query — with a recency cutoff that skips idle
  tags and is scoped to the agent's own records) and runs `ReflectMemories`
  once per tag under `scope:"tagged"`, so each user's candidates are distilled
  only from that user's sessions. Ordinary single-tenant agents (no `adk:`
  tags) fall back to the unchanged agentId-only distill. Candidates distilled
  under a tag now carry a `scopeTag` field, which `flair rem promote` consumes
  as the authoritative per-user lineage tag directly — closing the seam where a
  candidate whose source memories were all unreadable would otherwise promote
  tagless into the shared agentId namespace. Candidates still land
  `status:"pending"` for the existing human `rem promote` path (no
  auto-promote). Refs #1205.

- **Connector-conformance suite for the `/mcp` tools.** Every shipped `/mcp`
  tool now has a declarative consumer contract (shape + semantic invariants),
  co-located with its definition, driven against a seeded store through the tool's
  real implementation. The suite codifies the historical connector-bug classes —
  counted-equals-delivered, charged-equals-shipped, dedup-by-content-signature,
  self-describing empty containers, the same-estimator `tokenEstimate` check, and
  no leaked internal fields — and a fail-closed completeness check fails the build
  if a new tool ships without a contract.

- **Deterministic recall-quality eval + CI gate (flair-bench Layer 1).** A new
  fixed-corpus, fixed-label, fixed-seed recall eval computes recall@1/5/10,
  nDCG@10 and MRR against hand-curated relevant-memory labels, through Flair's
  real BM25+RRF retrieval at documented defaults — no LLM judge, no
  corpus-derived relevance. It is measured ±0.000 across runs and gates CI on
  per-metric floors set a margin of ≥2 whole queries above that noise band, so a
  breach is a real regression rather than sampling wobble. This is now the
  authoritative recall-quality number; the `flair quality` recall spot-check
  remains a live-health cratering probe (its self-pollution caveats are tracked
  in flair#967 / #857 / #996), and the composite-vs-raw recall-harness remains
  the scoring-config diagnostic. The shared ingest/retrieve/metrics plumbing
  (`packages/flair-bench/lib/`) is the foundation the LongMemEval_s harness
  (Layer 2) builds on unchanged.

- **Reserved the `machine:` reviewer namespace for automated promotions.**
  Promotions record a `reviewerId` for audit and attribution. The `machine:`
  prefix (canonical `machine:adk-auto-promote`) is now reserved for
  machine-driven promotion paths so automated decisions can never be mistaken
  for a human or agent reviewer, and `flair rem promote --reviewer` refuses any
  value in that namespace.

### Fixed

- **`bootstrap` org events now respect `maxTokens`, drop boot noise, and the
  counters add up.** The structured `events` array was assembled but never
  charged against the token budget, and every event shipped a verbose `detail`
  blob — a `maxTokens: 4000` request serialized at ~6286 (flair#1199). Events are
  now counted against the shared budget like every other content section, ship
  LEAN by default (opt the `detail` JSON back in with `includeEventDetail: true`),
  and honor a `maxEvents` cap. Zero-row no-op auto-heal migration events (the
  "graph-heal verified / migration success (0 rows)" pairs that fire every boot)
  are suppressed at render, freeing the scarce event slots for signal — the
  migration ledger still records every one (flair#1200). Count arithmetic is
  fixed too: `memoriesIncluded + memoriesTruncated` can no longer exceed
  `memoriesAvailable` (a memory considered in two sections was double-counted),
  and teammate findings now report `teammateFindingsMatched` (the relevance-floor
  pool) so `teammateFindingsTruncated` reads as "relevant but no budget," not
  "every candidate not selected" (flair#1207). The connector-conformance suite
  gains two invariants that catch these classes: `tokenEstimate <= maxTokens`
  (within a scaffolding tolerance) and `included + truncated <= available`.
  Connectors simply get a payload that fits the budget they asked for.

- **`/mcp` read paths no longer leak internal fields or throw a misdirecting
  error.** `memory_get` now strips `embeddingModel` alongside `embedding` (the
  write tools already dropped both, so the read path was the last leak), and
  `memory_update` against a non-existent id now returns a clean `not found`
  instead of throwing `Invalid primary key of null`. Nothing to do — connectors
  simply stop seeing an internal model-id field and get a parseable 404.

### Security

- **adk-flair: closed a tag-collision in the per-user scope tag (Python and
  JavaScript adapters).** Both the `adk-flair` (Python) and `@tpsdev-ai/adk-flair`
  (JavaScript) memory adapters built the `adk:<app>:<user>` scope tag by
  replacing `:` with `_`, so distinct identities like `alice:admin` and
  `alice_admin` collapsed to the same tag. Because that tag is the per-user
  access-control boundary, the collision could contaminate memory across users.
  Segments are now percent-encoded (reversible, collision-free) in both
  packages; no action is needed for existing installs, though any tag written
  for a user id containing `:` or `_` will differ from what the old scheme
  produced.

- **`flair rem promote` now preserves the source scope tag and fails closed
  for ADK-sourced candidates.** Promotion previously stamped only
  `nightly-rem-promoted` / `from:<id>` and dropped the candidate's source tag.
  For a candidate distilled from ADK session records (a source memory carries
  an `adk:<app>:<user>` tag), the promoted claim now carries that scope tag
  alongside the provenance tags. If such a candidate is ADK-sourced but its
  scope tag cannot be uniquely and completely determined (multiple distinct
  tags, or an unreadable source), or if it targets Soul (which is agent-scoped
  and cannot carry a per-user tag), promotion is refused rather than writing a
  claim that could leak across users. Non-ADK candidates promote exactly as
  before.

## [0.44.9] - 2026-08-15

### Added

- **Added the Antigravity CLI (`agy`) as a wire-able MCP client.** `flair init`,
  `flair doctor` and the client registry now detect Antigravity and can write
  the pinned `flair-mcp` server into its MCP config at
  `~/.gemini/config/mcp_config.json` (a sibling of, and distinct from, Gemini
  CLI's `~/.gemini/settings.json`). Note: the end-to-end wiring has not yet been
  verified against a live `agy` — after wiring, restart Antigravity and confirm
  the flair tools appear.

### Changed

- **`maxTokens` is documented and enforced as a content-selection budget (#1199).** The bootstrap `maxTokens` was described as bounding the output size but only ever bounded content selection; the serialized response could exceed it, and that gap was neither documented nor consistently enforced. It is now a hard cap on how much soul/memory/finding content is selected (every admitted line is gated against the shared budget), while `tokenEstimate` honestly reports the real serialized size — which may exceed `maxTokens` by the structured-container scaffolding. If a payload needs to be larger, raise `maxTokens`; the cap is no longer "fixed" by dropping content (that was the #1207 regression).

### Fixed

- **Bootstrap no longer drops relevant findings at the same `maxTokens` (#1207).** A per-item structured overhead and a scaffolding reserve introduced with the payload-honesty work were being charged against the *content-selection* budget, silently shrinking how much on-task memory shipped for a given `maxTokens` (relevant findings could roughly halve), and a large high-relevance record could be skipped while smaller, less-relevant ones still fit. Measurement is now decoupled from budgeting: `tokenEstimate` still honestly reports the real serialized payload, but the structural overhead no longer reduces the selection budget, restoring the prior finding count. A size-skip in the task-relevant pass is now reported (`memoriesTruncated` / `teammateFindingsTruncated`) instead of being silent, so a client can tell "no relevant finding" from "a relevant finding did not fit".

- **Bootstrap now delivers org events in a structured `events` container (#1206).** Since the prose `context` became opt-in, org events lived only in that prose, so on the default `/mcp` bootstrap path (prose off) they were counted and measured but never delivered in any field a connector could read. Bootstrap now always returns an `events` array (`[]` when there are none), parallel to `memories`/`teammateFindings`, with each entry carrying `id`, `kind`, `summary`, `createdAt`, and — when present — `detail`, `targetIds`, and `scope`. The events are deduped by content signature and target-scoped exactly as the prose section already was; the prose path (`includeContext: true`) is unchanged.

- **`flair upgrade` no longer reports a correctly-wired `flair-mcp` as "not
  detected".** It used to probe `flair-mcp` as a global npm install, but
  `flair-mcp` is zero-install via `npx` and is never installed globally — so a
  correctly-wired machine was told it was missing, with an `npm install -g`
  remedy that does nothing. Upgrade now detects `flair-mcp` by its actual wiring
  (the pinned version in a wired MCP client config, or the presence of the Flair
  SessionStart hook) and shows that version against the latest. "Missing" now
  means not wired anywhere; the remedy for a wired-but-behind or unwired
  `flair-mcp` is `flair doctor --fix`, never a global install.

- **Trust block carries both true age and freshness (#1201).** `ageDays` had been keyed off the record's last-write time, which overcorrected: a record created weeks ago but edited today read as brand new, losing its true age. `ageDays` now reflects true age (days since `createdAt`), and a new `staleDays` field carries freshness (days since `updatedAt`) — both are exposed rather than collapsed into one. `matchQuality` section-tagging is unchanged.

## [0.44.8] - 2026-08-15

### Fixed

- **Bootstrap payload quality: no double-serialization, honest token accounting,
  coherent counters, deduped org events, and freshness off `updatedAt`.** The
  `/mcp` bootstrap connector no longer receives every soul and memory body twice
  (once in the prose `context`, once in the structured containers): the
  structured `soul`/`memories`/`predicted` fields are canonical, teammate
  findings now ship in a new structured `teammateFindings` container, and the
  prose `context` is opt-in (`includeContext`, off by default on the `/mcp`
  path). `tokenEstimate` now reflects the actual serialized payload and
  `maxTokens` bounds it. `memoriesIncluded` is own-scoped so it can no longer
  exceed `memoriesAvailable`, with cross-agent hits counted separately as
  `teammateFindingsIncluded`. Byte-identical org events are deduped before the
  scarce-slot cutoff. Trust-block freshness (`ageDays`) now keys off a record's
  own `updatedAt` (falling back to `createdAt`), so a record edited today reads
  as fresh, and each bootstrap trust entry is tagged with its `section` so a
  `matchQuality` of null on a lifecycle load is legible rather than reading as a
  scoring failure.

## [0.44.7] - 2026-08-15

### Added

- **/mcp tools wrapper-layer test coverage.** Added an integration suite that
  drives every tool in the `TOOLS` registry through its real `.impl` wrapper
  in-process against an ephemeral Harper seeded with realistic data, asserting
  each returns the expected payload shape. Closes the coverage gap behind three
  connector regressions (#1181 unloaded-instance by-id reads, #1188 inlined raw
  embedding vectors, #1182 an un-awaited async spread) that shipped green
  because only the underlying handlers and the signed-REST path were tested,
  never the thin wrapper seam a real /mcp connector drives.

### Fixed

- **`/mcp` `soul_set` now persists instead of erroring.** The tool wrapper did a
  PUT on an unloaded resource instance (`new Cls(undefined, ctx).put(...)`),
  which threw `Invalid primary key type: undefined` against a real store — the
  same #1181 unloaded-instance class already fixed in the other tool wrappers.
  It now writes through a collection-bound `post()` (stamping the required
  `createdAt`), so setting a soul entry over a `/mcp` connector works and is
  readable via `soul_get`. Found by the new wrapper-layer test suite, whose only
  prior `soul_set` coverage exercised a mocked handler.

## [0.44.6] - 2026-08-15

### Fixed

- **The `/mcp` `bootstrap` tool now returns its full payload, not just the
  server version.** The wrapper spread an un-awaited Promise into its response,
  so every computed field — the resolved agentId, the scope descriptor, the
  soul map, the memories and predicted containers, and the opt-in abstention
  verdict — was dropped and a connector caller saw only `{ flairVersion }`.
  Awaiting the response restores the complete payload.

- **`flair doctor` no longer mistakes node-scoped federation keys for agent
  signing keys.** `~/.flair/keys/` holds two kinds of file — agent Ed25519
  signing keys (a `<name>.key` seed with a sibling `<name>.pub`) and
  node-scoped federation keys (`flair_<hex8>.key`, an AES-GCM keystore blob
  with no `.pub`). Doctor used to Ed25519-parse the node blob and warn that an
  agent's signing key "could not be parsed … (DECODER routines::unsupported)",
  which reads as agent-auth breakage when agent auth is fine. Node keys are now
  classified structurally and skipped, with an informative note instead of the
  false alarm.

  This also closes a way `flair doctor --fix` could wire a broken connector: on
  a host whose only key was a federation node key, `--fix` could infer that node
  id as the sole agent and write `FLAIR_AGENT_ID=flair_<hex8>` into a client
  config, so the connector authenticated as a phantom, unregistered node whose
  key cannot sign — failing every read and write. `--fix` now refuses to wire a
  node id from any source and points at `flair init --agent <name>` or
  `flair agent add <name>` instead.

## [0.44.5] - 2026-08-14

### Fixed

- **`memory_get` no longer inlines the raw embedding vector.** Retrieving a memory
  by ID over the `/mcp` connector returned the record's full 768-float `embedding`
  array inline — thousands of noise tokens per record on chat surfaces with a fixed
  context budget. The vector is now omitted by default; pass `includeEmbedding=true`
  to include it. The `memory_store` and `memory_update` responses are stripped the
  same way; `memory_search` and `bootstrap` already excluded it.

- **`memory_update` with `preserveHistory: true` no longer copies the superseded
  record's retrieval stats onto its successor.** The new supersedes-linked record
  now starts with `retrievalCount` at 0 and no `lastRetrieved`, instead of
  inheriting them from the record it replaces — which previously produced a
  successor whose `lastRetrieved` predated its own `createdAt` ("retrieved before
  it existed") and silently skewed recency- and usage-based ranking.
  `retrievalCount` and `lastRetrieved` are record-scoped and reset on succession;
  usage- and citation-ledger counters are unaffected.

## [0.44.4] - 2026-08-14

### Added

- **Bootstrap responses are now self-describing (flair#1182, part 1).** `POST /BootstrapMemories` (and the `bootstrap` MCP tool that wraps it) always emit the structured container keys `soul` (`{}`), `memories` (`[]`) and `predicted` (`[]`) even for an empty instance, so a caller can tell an *empty* instance from one that doesn't support them. The response also always carries the resolved `agentId` and a `scope` descriptor (`{ agentId, isAdmin, reads }`) so a caller can tell who the server thinks they are — a one-call diagnosis for read-gate bugs like #1181 — plus a `currentTaskHint` when `currentTask` (which is what turns on task-relevant retrieval, teammate findings and collision surfacing) is absent or blank. The new keys reveal only the CALLER'S OWN resolved identity and records; teammate findings stay in `context`/`sections.teammate` and are never duplicated into `memories`. Purely additive — every pre-existing response key (`context`, `sections`, token counts, `trust`, `abstention`) is unchanged. Parts 2 (MCP `initialize` instructions) and 3 (soul-as-onboarding docs) are tracked separately under the same issue.

### Fixed

- **`memory_get` / `memory_update` / `soul_get` / `memory_delete` no longer 404 on the caller's own record over the `/mcp` connector (flair#1181).** These tools reached the datastore with an instance by-id read (`new Cls(undefined, ctx).get(id)`); Harper routes `.get(<string>)` on an unloaded instance to a field accessor that returns `undefined`, so the by-id read gate saw no record and returned NOT_FOUND before the ownership check — one call after a successful `memory_store`. They now use the static `Cls.get(id, context)` form (the same transactional path the Ed25519 REST route takes), which loads the row and still dispatches through the per-agent read-scope gate. Own-records-only scope is unchanged. Nothing to do; connector reads that were vanishing now return.

  The `memory_update` write leg and `memory_delete`'s permanent-memory guard shared the same unloaded-instance defect (an instance `put`/`super.get` on `new Cls(undefined, ctx)`) and were migrated to the static path too. Server-side debug logging was added to the by-id read gate to distinguish an absent/failed-load from an ownership denial; the client-facing response stays `404` either way.

- **The CLI now resolves the signing identity ONE way for every command, with a documented precedence: `--agent` flag > `FLAIR_AGENT_ID` env > config profile (flair#1183).** Command families had drifted apart on this: `search`/`bootstrap`/`status`/`presence`/`workspace` honored `--agent` over `FLAIR_AGENT_ID`, but everything routed through the internal `api()` helper (memory search/list, the `soul` family, and the writes) re-derived the signer as `FLAIR_AGENT_ID`-first — so `--agent X` run with `FLAIR_AGENT_ID=Y` exported in the shell SIGNED as Y while the record it wrote and the query it filtered both named X. Against a remote target where Y wasn't registered, the server answered `unknown_agent`. The `soul` family was the worst case: it had no flag/env resolution of its own and leaned entirely on that env-first extraction, so even the `FLAIR_KEY_DIR` workaround couldn't steer it. All families now resolve the signer once, at the command boundary, and thread it down as an authoritative value; `api()` no longer overrides it from the environment. A config-profile-only user with no flag and no env is unaffected — the machine's ambient credential (admin-pass / agent-key floor) still applies below the flag/env tiers, exactly as before.

  Set `FLAIR_DEBUG=1` to print, on stderr, the identity each command resolved and which source won (e.g. `[flair] signing identity for 'soul set': X (source: --agent flag)`) — so operator, CLI, and server can't silently disagree about who's calling.

## [0.44.3] - 2026-08-14

### Fixed

- **`adk-flair` ships a runnable cross-session-recall quickstart.** New
  `examples/quickstart.ts` (JS) and `examples/quickstart.py` (Python) plant a
  fact in one session, wait for a freshly-booted Flair to make it searchable,
  then recall it in a brand-new session and print the result — reliable on a
  cold instance without weakening the adapter's production 2s search budget.

- **`adk-flair` reads the keyfile `flair agent add` actually writes.** The ADK
  memory adapter (Python and JS) now accepts the raw 32-byte Ed25519 seed that
  `flair agent add` writes to `~/.flair/keys/<id>.key` — alongside base64-encoded
  seeds, base64 PKCS8 DER, and PEM — and expands a leading `~` in `FLAIR_KEYFILE`.
  Following the documented quickstart no longer fails with a cryptic ASN.1 decode
  error, and a missing keyfile now raises a clear message naming the resolved path.

## [0.44.2] - 2026-08-14

### Changed

- Bumped `@harperfast/oauth` to 2.5.0 (upstream oauth#200 — CIMD auth on Fabric for claude.ai remote MCP).

## [0.44.1] - 2026-08-13

### Fixed

- `flair upgrade` now re-pins MCP client configs to the newly installed version. Previously, the CLI version was cached at module load and never invalidated after `npm install -g` replaced `package.json` in-process, so the pin refresh wrote the OLD version back into client configs — a no-op. The upgrade path now clears the version cache after package install and refreshes pins before restart, covering `--no-restart` and `--no-verify` paths as well.

- `flair upgrade --check` and the doctor hook-warning path no longer suggest globally installing `@tpsdev-ai/flair-mcp`. flair-mcp is zero-install via npx; the advice now points to `flair doctor --fix` instead.

## [0.44.0] - 2026-08-13

### Fixed

- Fixed the SessionStart hook command so it runs the `flair-session-start` binary instead of the MCP-server shim. The old form `npx -y @tpsdev-ai/flair-mcp flair-session-start` ran the package's default bin (the shim) and passed `flair-session-start` as an ignored argument. The corrected form `npx -y -p @tpsdev-ai/flair-mcp flair-session-start` uses `-p` to select the package so the named bin runs.

## [0.43.0] - 2026-08-13

### Added

- **Fabric deployment docs corrected for 5.2+.** Fixed ops-API port (9925, same hostname),
  clarified cluster_status availability on Fabric, documented the mcp.enabled manual flip
  and its upgrade-reverts trap, and versioned log paths (hdb.log froze at 5.2, system.log
  is the live log 5.2+). Closes #1153, #1156, #1157.

### Changed

- **boot-harper.mjs** now emits `rootPath` and `harperPid` in the JSON config line, enabling callers to recover from an interrupted teardown (kill by explicit PID, remove the install tree). The teardown contract is documented in the header comment, and `hdb.pid` is removed only after teardown fully completes, making a surviving `hdb.pid` a reliable orphan indicator.

- Removed dead `applyRemoteConfigAndRestart` function and its `ApplyConfigAndRestartParams` interface from `src/lib/mcp-enable.ts`. The function was test-only since #1136 removed `set_configuration` delivery; Fabric regenerates the root `harperdb-config.yaml` and the component's own `config.yaml` is the source of truth for the oauth block. Updated the stale JSDoc on `buildMcpOAuthConfigBlock` to reflect this.

- The quickstart now notes that `flair search` outputs JSON for non-TTY callers (scripts, pipes, CI) and documents the JSON fields and `--json` flag (#1139)

### Fixed

- `flair doctor` now distinguishes a cold npx cache on a fresh install from a genuinely-broken SessionStart hook, and no longer suggests an unrelated Node-runtime-mismatch remedy (#1131)

- Fixed ops URL derivation for Fabric https targets: the ops API port is now the well-known Fabric ops port (9925) for https targets with effective port 443, instead of the dead-end port-1 derivation that produced :442. Self-hosted TLS installs with non-443 explicit ports are unchanged (port-1 convention preserved). The unreachable-ops error now names both `--ops-target` and `FLAIR_OPS_TARGET` with the exact host:port tried.

- **test**: HOME-isolate `resolveOpsPort` unit tests so they exercise the `httpPort-1` default path regardless of the host's `~/.flair/config.yaml`. A `mock.module("node:os")` shim makes `homedir()` delegate to `process.env.HOME`, and a `beforeEach` points HOME at a fresh empty temp dir so the config rung is correctly skipped.

## [0.42.0] - 2026-08-12

### Fixed

- The CLI now reaches Flair instances on non-standalone shapes without FLAIR_URL. api() (used by ~30 commands incl. memory add/search and the rem family) carried a stale duplicate port-resolution ladder that skipped Harper's own config and fell through to the 19926 default, so every fleet/Fabric install serving 9926 got ECONNREFUSED; api() now delegates to the single canonical resolver.

- **`flair upgrade` (and re-running `flair init`) now refreshes stale MCP client-config pins to the running version.** The three client-wiring guards — JSON clients, the inline Claude Code wiring, and the Codex TOML section — treated any existing wiring as up-to-date, so once a client was wired to `@tpsdev-ai/flair-mcp@<version>` it stayed on that pin even after the CLI was upgraded. The guards are now version-aware: a wiring whose URL and agent still match but whose pin is stale is re-written to the current version, and `flair upgrade` runs this refresh across detected clients as a best-effort step (a refresh failure warns but never fails the upgrade). The flair#907 pin still holds a wired client to a known version between upgrades — this just makes an upgrade actually advance it. (#1135)

- MCP-OAuth config now ships in the component config.yaml (mcp.enabled: false default, inert), replacing the set_configuration delivery that Fabric regenerated away; flair mcp enable drops the config leg and reports the operator-deploy path on Fabric.

## [0.41.0] - 2026-08-10

### Changed

- **Harper is now 5.2.0, and its SQL engine default changed.** Flair pinned Harper 5.1.22;
  5.2.0 is the first stable release of the 5.2 line. Two consequences worth knowing. First,
  **`sql.engine` now defaults to `auto`** rather than `legacy`: queries are planned by
  Harper's Resource-API engine and fall back to the legacy AlaSQL path only for shapes it
  does not support. Set `sql.engine: legacy` to restore the previous behaviour, or `new` to
  disable the fallback and surface unsupported shapes as errors. Second, this carries a
  storage read fix that 5.1.22 did not have: in the `@harperfast/rocksdb-js` version that
  range permitted, a column-family override was honoured on the synchronous block-cache
  attempt but dropped in the async worker, so every table after the first in a request was
  read through a foreign column family — cache hits correct, **cache misses silently
  returning not-found**, worst immediately after a restart and healing as traffic warmed
  the cache.

### Fixed

- **Upgrade-liveness compat test reads data back during the live window.** The reverse-guard leg's reinstall replaces the local CLI and stops the upgraded instance; the data-survival read-back is now captured while the upgraded instance is live, making it a genuine cross-engine proof instead of a dead-world read.

- The MCP client-credentials e2e test's `afterAll` teardown now carries an explicit 180s timeout (mirroring its `beforeAll`); its `rm -rf` of the hard-linked temp component tree had outgrown the default 5s hook budget as the dependency tree grew, surfacing only in the macOS release lane.

- Upgrade-liveness compat test now runs the real consumer direction (published → local build) and asserts the backwards-engine refusal explicitly, skipping loudly when engines match — engine-forward PRs no longer red circularly.

- **`flair upgrade` restart handles Harper engine changes end-to-end.** The restart path now sets `CONFIRM_DOWNGRADE=yes` so Harper's non-interactive confirm prompt doesn't silently exit 0 under launchd/systemd, waits for the old process to release its data-directory lock before starting the new one, and the rollback path restores the pre-upgrade engine snapshot when the Harper version changed (refusing loudly when no snapshot exists — the old Harper cannot read data written by the new engine).

## [0.40.0] - 2026-08-07

### Added

- **adk-flair: integration tests for explain-plan, portability, and quickstart parity.** New `tests/test_explain_plan.py`, `tests/test_portability.py`, and `tests/test_quickstart_parity.py` with a `live_flair` pytest marker that skips visibly when no live Flair is configured. Includes ephemeral Harper boot helper and test README.

- **New `@tpsdev-ai/adk-flair` package — Flair memory backend for Google ADK (JS/TS).**
  Implements `BaseMemoryService` from `@google/adk` with Ed25519 request signing,
  compound-tag scoping (`adk:<app>:<user>`), and silent-degrade health warnings.
  Ports the Python `adk-flair` design to TypeScript with the same conformance
  suite (explain-plan, portability, quickstart-parity).

- adk-flair publishes to PyPI via OIDC trusted publishing on `adk-flair-v*` tags.

### Changed

- adk-flair versions now track flair's minor while 0.x (compat-signal policy).

### Fixed

- **`flair mcp enable` verifies the process actually restarted.** Before
  calling `restart`, the command captures the running process PID via the
  ops API and re-checks it after the restart completes. If the PID is
  unchanged (thread bounce / no-op restart) the step fails with a
  loud error naming the actor, state, and remedy, and `enable` exits
  non-zero without printing a success checkmark. Fixes #1120 (sub-issue A).

- **MCP enable: capture-boot failure now attributed to `apply-config-and-restart`, not `identity-mapping`, and the restart-timeout message names the manual-recovery remedy.** `captureBootDiscriminator` is the first act of the apply-config-and-restart step so its errors belong there; the dead `verifyProcessRestart` comparison function is deleted (the gate was never reached because `waitForOpsApi` throws on timeout).

- Release tooling: adk-flair-js added to the version-bump and stage-publish lists — the 0.40.0 cut failed its post-bump guard because the new package was not a bump site.

## [0.39.0] - 2026-08-06

### Added

- **adk-flair: Flair as the memory backend for Google ADK agents.** New `packages/adk-flair` Python package implementing `BaseMemoryService` with compound-tag user scoping, Ed25519-signed API calls, and semantic search. Published to PyPI as `adk-flair`.

### Fixed

- Fix `mcp enable` secrets push to send `processEnv: true` instead of `tier: processEnv` and verify the field on read-back so inert rows (core ignoring unknown params) are caught rather than silently failing at boot. Closes #1105

## [0.38.0] - 2026-08-05

### Added

- **`flair mcp enable` now pushes its secrets to the target when the target can take them**, instead
  of always ending in a manual paste. When the instance supports Harper's encrypted env-secrets, the
  five vars are sealed locally and set over the ops API — no Fabric Studio step, no re-run with
  `--confirm-secrets-applied`.

  Values are encrypted **before** they leave the machine, using the same `enc:v1:` envelope Harper
  reads: AES-256-GCM on the value, RSA-OAEP(SHA-256) wrapping the key, addressed to a public key
  fetched from the target. Plaintext never appears in a request body, and never in the command's
  output — results carry variable NAMES and outcomes only.

  **The mechanism is chosen by asking the target, not by looking at its hostname.** The previous
  selector was `hostname.endsWith(".harperfabric.com") ? automated : manual`, which was wrong in both
  directions at the moment it was replaced: the Fabric instance it was written for runs Harper 5.1.26
  and has no secrets operations at all, while a self-hosted Harper 5.2 with the env-secrets component
  was sent down the manual path for having the wrong name. A hostname is not a capability, and
  neither is a version — the write operations and the decryptor that makes the secret reach the
  process ship separately.

  So `enable` asks for the public key it would need anyway. If that answers, it pushes. If the target
  says the operation does not exist, refuses the probe, is unreachable, or answers with something
  unusable, it falls back to today's staged file and **says which of those happened**. The staging
  file is written either way, so a fallback never leaves an operator stranded mid-run.

  What the probe deliberately does not claim: that the secret will be *decrypted*. No read-only call
  can establish that. The existing self-verify step already does, by comparison rather than absence: the
  well-known endpoint still answers when the flag is off, serving flair's own OAuth 2.1 document,
  and self-verify recognises it by the advertised `token_endpoint`. So a secret that is stored and
  never decrypted fails there with a message naming `FLAIR_MCP_OAUTH`, rather than passing quietly.

  `--secrets-mechanism` remains an explicit override and skips the probe entirely: an operator who
  has said what they want is not second-guessed.

## [0.37.0] - 2026-08-04

### Fixed

- **`--admin-pass`'s help text and error no longer promise something the code deliberately refuses.**
  For a remote target, `flair mcp enable` requires the password explicitly — `FLAIR_ADMIN_PASS` and
  `~/.flair/admin-pass` are skipped on purpose, because they are *this* machine's local admin
  credentials and sending them to another instance is how a local secret ends up on someone else's
  Harper. That guard is correct and unchanged.

  What was wrong is that three places described it three different ways: `--help` and the error both
  said `FLAIR_ADMIN_PASS` would work, one call-site comment described the goal as blocking only the
  *file* fallback, and the resolver's own doc said both legs are skipped. Only the last matched the
  code, and it was the one an operator never sees.

  The error now says explicitly that the env var and the local file are not used for a remote target
  **and why**, so the refusal is actionable instead of looking like a bug. Reported by an operator who
  had exported `FLAIR_ADMIN_PASS`, watched it be ignored, and reasonably filed it as broken.

- **The changelog gate now asks whether *your* change wrote an entry, not whether the directory is
  non-empty.** The old rule fired only when `.changelog/unreleased/` was empty *and* feat/fix commits
  had landed since the last tag — so the first PR after a release cut satisfied it for every PR that
  followed, until the next cut emptied the directory again.

  That is not hypothetical. On 2026-08-03 four PRs merged with no fragment while the directory held
  three entries from earlier work; the gate passed on all four, and v0.36.0 was assembled with
  release notes omitting three authz security fixes — the entire reason to upgrade. They were
  backfilled by hand at the cut, which is the moment this check exists to make unnecessary.

  The gate now also compares against the PR's merge base and requires a fragment to have been
  **added** in that range. Editing an entry someone else staged is not writing your own. The
  since-tag rule is kept, because it still catches the empty-directory-at-release case; where no
  base ref is reachable (shallow clone, no `origin`) the per-change half is skipped and the
  since-tag half still runs.

- **`flair doctor` no longer reports the local CLI's version as the instance's.** Pointed at a
  deployed instance, every line doctor printed was genuinely remote — uptime, PID, memory counts —
  except the one that mattered: it ran the currency check against `__pkgVersion`, the CLI you happen
  to have installed, and printed `flair <x> is current`. Reported against an instance five minors
  behind, where doctor said "current". Telling you that is doctor's entire job.

  It now probes the target's `/Health` and reports the version running **there**, and warns
  separately when the local CLI and the instance differ.

  **An undeterminable version is reported as unknown and counts as an issue — it never falls back to
  the local number.** An older instance may not expose its version at all, and substituting the one
  already in hand is exactly the bug being fixed. A Fabric node mid-failed-deploy reports a
  non-semver marker (`dev`); that is a real answer from a real server and still cannot be compared
  against a published version, so it is treated as undeterminable rather than fed to a semver check.

- **The downgrade lane could only ever observe a hang, because the old binary was waiting for
  someone to type "yes".** Starting an older Harper against a store written by a newer minor calls
  `forceDowngradePrompt()`, which asks whether to proceed and **blocks on stdin**. The prompt and
  its accompanying version warning are written to stdout only — never to the log — so in CI the
  process simply stopped, with nothing in the output explaining why.

  The lane classified that correctly as a hang (the outcome the invariant forbids), but it meant the
  other two branches were untestable: the check could never distinguish "the old binary boots
  cleanly" from "the old binary refuses loudly", because it never got past the prompt to find out.
  An invariant naming three outcomes was being enforced against one.

  Both enforcement points now set `CONFIRM_DOWNGRADE=yes`, which pre-answers the prompt. The
  exit-124 hang check is deliberately kept — a hang that survives the override is a genuine hang and
  still fails the lane, now with a message saying the known prompt cause has been ruled out.

  The value must be lowercase `yes` or `y`: Harper tests membership in an allowlist behind a
  case-sensitive pattern, and the prompt library **discards an override that fails validation and
  falls through to reading stdin** — so `YES`, `true`, `1` or a trailing space reproduce the exact
  hang this avoids. Measured against harper 5.1.22 with prompt 1.3.0.

  Filed upstream as HarperFast/harper#2046; the migration itself is additive and reversible, which
  is the opposite of what the silent hang suggested.

- **The refusal to boot against a newer engine's data now runs on every boot path.** `flair start`
  refuses when the data directory was written by a newer Harper — but that check had exactly one call
  site, inline in `start`'s own action. `flair restart` goes straight to `restartFlair` →
  `startFlairProcess` and never reached it, `flair upgrade` restarts by spawning the newly installed
  CLI with `restart`, and the snapshot paths took the same unguarded route.

  So the guard covered one of the doors a boot comes through, and not the one an **engine swap**
  arrives by. Upgrading across a storage-format boundary left the instance down with a bare exit 1,
  and the only explanation surfaced minutes later from the storage layer as an error about
  compression internals — nowhere near the cause, and naming no remedy:

  ```
  the instance is REACHABLE after the upgrade   Expected: >= 200   Received: 0
  the upgrade reported success                  Expected: 0        Received: 1
  ```

  The check is now a single function called from the top of `startFlairProcess`, before anything is
  spawned or launchd is touched, which covers its callers — restart, upgrade and the snapshot paths
  — in one place, plus `start`, which performs its own spawn and keeps its own framing and exit
  code. Deliberately one function rather than a second copy: these two sites had already drifted once
  on the spawn environment, where `start` set a host-qualified ops port and `startFlairProcess` set
  none, silently re-widening the ops API on every restart.

  **`flair restart` and `flair upgrade` now refuse rather than attempt the boot**, and the refusal
  names the restore-from-backup path. An install whose engine version cannot be read is unaffected,
  as before.

  Tests assert the wiring rather than the logic, which was already covered: the decision has exactly
  one implementation in the CLI, the guard precedes the first spawn, and a future boot path that
  bypasses `startFlairProcess` fails the check rather than passing unnoticed.

- **`models/*.gguf.downloading` is now ignored.** `.gitignore` covered `*.gguf` but not the
  in-progress placeholder Harper writes beside it, and the integration harness points
  `FLAIR_MODELS_DIR` at the repo's own `models/` directory — so a killed test run left an untracked
  file in the working tree.

- **The error no longer accuses the principal.** A failed lookup reported
  `failed to look up principal '<x>' (HTTP 404)`, which sends the reader to inspect principals. But a
  *missing* principal returns `200 []` and the very next branch creates it — reaching that error
  means the ops **call** failed, not that the identity is absent. It now names the URL it tried, and
  on a 404 says the address is probably the served origin and points at `--ops-url`. An error that
  misdirects costs more than one that simply says no.

- **`flair mcp enable` sent its ops-API calls to the served origin, and blamed the wrong thing when
  they failed.** Against a hosted instance the ops target was the instance URL verbatim — so the
  calls went to port 443, where the flair REST component owns `/` and answers `404 Not found`.
  Measured against a live Fabric instance, same request:

  ```
  POST https://<host>/        -> HTTP 404  "Not found"
  POST https://<host>:9925/   -> HTTP 200  []
  ```

  The ops API now gets the hosted ops port rather than the served one, and `--ops-url` overrides it
  outright. **No arithmetic on the served port is trusted:** the codebase elsewhere documents
  "ops port = HTTP port − 1", which derives 442 — also measured dead, along with 19925. An operator
  can put the ops API anywhere, so an explicit target always wins.

- **A failed `flair mcp enable` step is now reported against the step that failed.** The catch
  attributed errors to `steps[steps.length - 1]` — the last step that *succeeded* — so a throw inside
  identity mapping was filed against secrets provisioning, which had just completed:

  ```
  ✓ secrets-provisioning   ...apply these 5 vars via Fabric Studio, then re-run
  ✗ secrets-provisioning   unexpected error: Identity mapping: ... (HTTP 404)
  ```

  Two results for one step name, and the `✓` instructs several minutes of manual work in a web UI
  that the `✗` makes pointless. Read in reading order — which is how people read — you do the work
  first and discover afterwards that the step failed anyway. It also makes a run un-skimmable:
  scanning for the first `✗` finds a `✓` for that same step above it.

  A test asserts the narrow fact (an identity-mapping failure reports `identity-mapping`) and a
  broader invariant: no step name may carry both a pass and a failure in one run.

- **Removed the redundant `postinstall` chmod.** npm already sets the executable bit on files
  referenced by `bin` when it links them; the script changed nothing and cost a line in npm's
  install-script approval prompt, on a package whose install output is already noisy.

- **`docs/upgrade.md` no longer links to a CHANGELOG that isn't there.** The guide ships in the npm
  package and pointed at `../CHANGELOG.md`, which the `files` allowlist excludes — so the first
  instruction in the upgrade guide was a dead link for every reader who installed from the registry.
  The three links now resolve to the published copy on GitHub, rather than adding a 1400-line file
  to an install that is already too heavy.

### Security

- **A deploy no longer ships the whole working tree.** `harper deploy` packs its root wholesale, and
  the code assumed that root was an npm-installed package — where the tree already *is* the published
  file set. That assumption is true for the intended path and silently false for the one our own
  deploy procedure prescribes: a git checkout.

  Measured on a production Fabric component: **36 top-level entries**, including `.git`, `.env`,
  `models/` (80 MB), `test/`, `packages/`, `src/`, and a scratch `pr-body.md` left in the clone that
  afternoon. **96 MB against the published tarball's 1.3 MB.**

  Two consequences. An operator deploying from a checkout shipped `.git` — every secret ever
  committed and later removed — and any `.env` sitting in the tree, into a component that is then
  persisted and replicated across the cluster. And a 96 MB payload is what puts a deploy inside
  HarperFast/harper#2062's aborted-transaction window, where the pre-saved blob is destroyed at the
  source. The bloat and the cluster failure were the same bug wearing two hats.

  Staging is now unconditional and restricted to the entries `files` declares, read from the deploy
  root's own `package.json`. The payload equals the published package **by construction** rather than
  by an operator happening to run from the right directory. For an npm-installed root the result is
  unchanged, because such a tree contains nothing else. Measured after: 10 entries, 3.8 MB — `.git`,
  `models/`, `packages/`, `test/`, `src/` all gone.

  `.env` is explicitly kept: it is not in `files` and never reaches npm, but `config.yaml`'s
  `loadEnv` reads it and shipping it is the point of the staging mechanism. Filtering it out broke
  `FLAIR_PUBLIC_URL` on every deploy — caught by an existing test rather than in production.

  A root with no usable `files` array is now **refused** rather than deployed unfiltered. The
  refusal names the remedy.

- **`hono` pinned forward to `^4.12.34`** — GHSA-8j4g-w8fx-2239, a ReDoS in the CORS middleware via
  `Access-Control-Request-Headers`. Reaches us transitively through
  `@tpsdev-ai/flair-mcp › @modelcontextprotocol/sdk`, so it is not fixable by changing a direct
  dependency.

  This advisory was published **after** the previous override batch merged, which is worth recording:
  the dependency gate now goes red on main whenever a new advisory lands against something in the
  tree, and on 2026-08-03 that happened four times in one evening. The gate is telling the truth —
  main really is exposed until the pin lands — but "main is red" stops carrying information if it is
  the normal state. Worth a deliberate policy rather than a reflex.

- **`REQUIRED_PACKAGE_FILES`'s "keep in sync" comment is no longer a promise nobody kept.** It
  claimed to mirror `files`; nothing compared them, and they drifted invisibly for as long as the
  comment existed. The payload is now derived from `files` directly, so there is one source of truth
  and nothing to synchronise by hand. Four tests assert the deployed set — including that the filter
  is not over-broad, since a filter that drops everything would also pass a "no `.git` shipped" check.

- **Seven advisories resolved by pinning three transitive dependencies forward.** A wave of
  advisories published on 2026-08-03 took the dependency gate from one blocking entry to seven, and
  five of them were the same package:

  | package | advisories | worst |
  |---|---|---|
  | `undici` → `^8.9.0` | 5 | **high** — cross-user information disclosure |
  | `brace-expansion` → `^5.0.9` | 1 | **high** — DoS via unbounded intermediate arrays, bypassing the CVE-2026-14257 mitigation |
  | `fast-uri` → `^4.1.2` | 1 | **high** — host confusion via backslash |

  All three reach us transitively — through `pi-coding-agent`, `openclaw`, and
  `harper › @fastify/static › glob › minimatch` — so none could be fixed by changing a direct
  dependency. Total advisories drop from 21 to 14, and every remaining one is allowlisted with a
  dated justification.

  These are plain version overrides, deliberately **not** `npm:` aliases. flair#750 records an alias
  override (`harper` → `npm:@harperfast/harper@…`) that collided with the already-installed scoped
  copy, left npm's tree `invalid`, and made any second npm operation fail — which broke the clean-VM
  install gate and was reverted. A version constraint introduces no second package name, so that
  failure mode is absent by construction. Verified: build, a second `bun install` against the
  reified tree, and the full unit suite (3859 tests) all pass.

  Worth stating for whoever revisits these: an override is a **forward pin, not a fix**. Each one is
  correct only until the upstream dependency resolves the advisory itself, at which point the
  override becomes a pin holding a version we no longer need to hold. Re-check them at each
  dependency bump rather than treating them as settled.

- **A misspelled `visibility` no longer writes a memory everyone can read.** `PUT /Memory/<id>` with
  `{"visibility":"prvate"}` was accepted, and the read scope resolves visibility by exact match on
  `private` — so the typo, a wrong case, or a retired tier like `office` all read as non-private and
  were visible to every agent on the instance. flair#1006 closed this at the CLI flag and the MCP
  tool argument; REST and the in-process API reach `Memory.put()`/`post()` without passing either.

  Both now refuse an unrecognised value with `400 invalid_visibility`, naming the two valid values
  and how to opt out. Refusing rather than dropping the key is deliberate: dropping it falls through
  to the durability-keyed default, which for a permanent or persistent write is `shared` — the same
  widening, arrived at silently.

  **The read predicate is deliberately left permissive.** A row written before the field existed has
  no visibility and must keep reading exactly as it always did. So write-validation is strictly
  stronger than read-resolution, and the two must not be collapsed into one predicate — there is a
  test whose only job is to fail if someone tries.

## [0.36.0] - 2026-08-03

### Changed

- Restated the downgrade invariant (flair#1050): there is never a silent bad
  outcome — either the old binary boots and serves the corpus correctly, OR it
  refuses to start with a message naming what wrote the store, what is running,
  and how to recover, with a pre-upgrade snapshot that restores the store to a
  working state. The migration CI lane and downgrade-boot compat test now assert
  both branches, and the snapshot-opt-in rationale in docs and CLI docstrings
  reflects the restated guarantee.

### Fixed

- **A crashed test run no longer leaves `config.yaml` permanently modified.**
  `mcp-client-credentials-e2e` wrote the OAuth component block into the repository's real
  `config.yaml` and restored it in `afterAll`. A kill or crash mid-run left the block in place,
  and the next real instance start would silently 404 on `/.well-known/oauth-authorization-server`
  — the OAuth surface was absent with no error, because `@harperfast/oauth` is not a declared
  dependency in the shipped config. The test now stages the block into a temp copy and points
  Harper at it; the real `config.yaml` is never touched.

- Deactivated principals are now rejected on both authentication paths
  (Ed25519 and Basic/agent-auth).  A deactivated agent can no longer
  authenticate with a new Ed25519 signature or a Basic credential.

  **Known limit, and its actual scope:** already-issued OAuth Bearer tokens are not
  checked against principal status.  **On a default deployment this is not an
  exposure** — `/mcp` is the only surface that accepts a Flair-issued Bearer token,
  it is not registered unless `FLAIR_MCP_OAUTH` is set, and Harper's own auth layer
  claims any other `Bearer` header before a Flair resource sees it.

  **If you have enabled MCP OAuth**, a deactivated agent's existing token keeps
  working against `/mcp` until that token expires or is revoked, because the MCP
  guard validates the JWT cryptographically without consulting the Agent table.
  Until revocation-on-deactivation lands as a follow-up slice, deactivating an agent
  on such a deployment should be paired with explicitly revoking its tokens.

  So this slice covers "deactivation stops new authentications" everywhere, and
  "deactivation stops all access" everywhere except an MCP-OAuth-enabled deployment.

- **A hung old binary during a downgrade check is now reported as a hang, not as a clean refusal.**
  The downgrade invariant names three outcomes — the old binary boots, it refuses loudly, or
  anything else — and both enforcement points folded the third into the second. A timeout therefore
  printed a diagnosis stating the opposite of what had happened: an unbounded hang reported as a
  correct, loud refusal.

  Timeouts are now classified before the refusal check and fail with their own message. A pure
  `classifyDowngradeOutcome()` covers the three outcomes explicitly, so an invariant naming three
  states no longer has two branches.

### Security

- **Creating a `Credential` is now gated and attributed to the authenticated principal.** The
  resource declared a read gate and a cross-principal check on update, but no gate on creation — so
  a `POST` to the collection reached the base implementation with no cross-principal check, and
  `principalId` was taken from the request body.

  Creation now requires a verified principal, and `principalId` is stamped from the authenticated
  identity rather than trusted from the body. A non-admin agent can only create credentials
  attributed to itself.

  **Upgrading is recommended.** The gap was in creation only; existing credentials were never
  readable across principals.

- **`FeedMemories.post()` now attributes writes to the authenticated principal and refuses
  mismatched ones.** It previously read `agentId` from the request body and passed it into a
  full-record write, so a verified agent could write memories attributed to another agent, or target
  an existing record by supplying its `id`.

  `agentId` is now stamped from the authenticated principal; a body-supplied `agentId` that
  disagrees is rejected with `403` rather than silently overwritten. A body-supplied `id` is checked
  against the existing record's ownership before the write proceeds.

  **Upgrading is recommended for multi-agent deployments.** This path was previously documented
  in-code as deferred debt; it is now closed.

- **Read-scope enforcement in `Memory.search()` and `WorkspaceState.search()` no longer depends on
  the caller's query operator.** Both resources composed their ownership condition in a way that a
  caller-supplied top-level operator could weaken, so an authenticated agent could receive records
  belonging to other agents. Ownership is now enforced as the outer `AND` around the caller's own
  query block, matching the composition `MemoryCandidate` already used.

  **Upgrading is recommended for any deployment that serves more than one agent.** Exploitation
  requires an authenticated principal — it is not reachable anonymously — but it crosses the
  per-agent read boundary, which is the boundary Flair exists to hold.

  The composition now lives in one place, `makeScopedSearch()` in `record-type-kit.ts`, rather than
  being hand-rolled per resource. It had been written three times and was correct once; a shared
  implementation is what stops the next resource from getting it wrong. Boolean-injection guard
  tests now cover every scoped resource, not just the one that happened to be correct.

## [0.35.0] - 2026-08-02

### Added

- **Flair now stamps the data directory with the Harper engine version and refuses to boot when the store was written by a newer engine.** If an older Harper boots against a store written by a newer one, the error names both versions, the data directory, and the remedy — reinstall the newer version or restore from a pre-upgrade snapshot.

  This only helps from the release that ships it onward: the check lives in the version being downgraded *to*, so it cannot rescue a downgrade to a build that predates the stamp.

### Changed

- **Pre-upgrade snapshots are now automatic when the Harper engine version changes.** The tested-downgrade guarantee that justified making snapshots opt-in does not hold across engine version boundaries — a Harper bump is the only realistic source of a cross-version boot break. Opting out requires `--no-engine-snapshot` and prints what is being given up.

  Ordinary flair-version upgrades (same Harper) remain opt-in via `--snapshot`.

### Fixed

- **Turning on MCP OAuth without the authorization-server component now logs a visible error at boot.**
  Enabling MCP OAuth is two steps, and the guard tells you the second one. `FLAIR_MCP_OAUTH=on`
  requires the `@harperfast/oauth` component, which ships commented out in `config.yaml` so it loads
  only on instances that use it. Turn the flag on without uncommenting and flair logs an error at
  boot naming the flag, the missing component, and the exact YAML to uncomment, and records the
  surface as not mounted (visible on the admin Instance page). The guard does not stop the boot — an
  optional feature must not deny service to the core one. Previously the flag could be on with the
  component absent and flair booted without error while `/mcp` silently rejected every request
  (#1021).

- **`flair keys prune` no longer archives a key file it cannot identify.** `~/.flair/keys/<id>.key`
  is a namespace shared by two writers: plaintext Ed25519 seeds, and AES-256-GCM keystore blobs
  written by `FileKeyStore`. A keystore blob does not parse as a seed, and prune classified any
  unparseable file as `invalid` — which is prunable — so it would move a **live federation key**
  into `.pruned/`. Recoverable, since prune archives rather than deletes, but wrong in the
  direction of touching a key that is in use. Unparseable files are now classified
  `unidentified`, reported for a human, and left where they are. "I could not parse this" and
  "this is a stale agent key" are different findings, and only the second is safe to act on.

- **Backwards-boot recovery message now names an actual snapshot file instead of a literal placeholder.** When a downgrade prevents Flair from starting, the error message inspects the pre-upgrade snapshot directory and prints a runnable `flair snapshot restore` command with the newest snapshot. If multiple snapshots exist it also mentions `flair snapshot list`. If no snapshot exists it says so plainly and omits the restore line entirely — suggesting a restore that cannot work is worse than being honest about having nothing to restore from.

- **The test suite is now type-checked in CI.** Both project tsconfigs excluded `test/`, so
  `tsc --noEmit` — what CI runs as its Type Check lane — never read a test file, and bun's
  transpiler strips types rather than checking them. A guard test could call a function that
  no longer exists, pass a wrong-shaped argument, or assert against a renamed property, and
  the only signal was whether it happened to fail at runtime. That matters most for guard
  tests, which are how we know a control still works. A new `tsconfig.test.check.json` covers
  the suite under `strict`, with an explicit exclude list for the files carrying a known
  backlog — a visible, shrinkable list rather than a blanket relaxation, since relaxing the
  compiler options until everything passed would have bought coverage of ~30 files by
  weakening the check on ~260.

### Security

- **The admin Instance page now HTML-escapes `publicUrl` in the Endpoints table and Public URL card.**
  `FLAIR_PUBLIC_URL` is operator-set and not validated, and as of 0.34.0 the deploy step writes it
  into the component's `.env` — so a value that used to be typed at a prompt now arrives through a
  payload. The fix escapes on output at every interpolation site rather than sanitising the input,
  which is the wrong layer. An operator setting a hostile value on their own instance is attacking
  themselves; this is fixed because the shape is wrong and the input path widened, not because it
  represents a meaningful external threat (#1029).

## [0.34.0] - 2026-08-01

### Added

- **OAuth discovery is now served at the two well-known paths clients actually
  probe.** `GET /.well-known/oauth-authorization-server` (RFC 8414) and
  `GET /.well-known/oauth-protected-resource` (RFC 9728, which the MCP
  authorization specification makes a MUST) both answer, unauthenticated, over
  CORS. Flair published a correct document only at `/OAuthMetadata` — a path
  nothing in the ecosystem asks for — and 404'd at both standard paths, so a
  spec-compliant remote MCP client could not discover an instance at all.

  The protected-resource document is also served at the RFC 9728 §3.1
  path-appended URL `/.well-known/oauth-protected-resource/mcp`, which is the
  form real MCP clients construct and the form the `/mcp` surface's own 401
  challenge points at.

  `/OAuthMetadata` is unchanged for existing callers and is now an **alias**:
  both paths return the same document from the same builder, so they cannot
  drift apart. Nothing about issuer derivation changed — set `FLAIR_PUBLIC_URL`
  on any non-loopback deployment or every advertised URL still points at the
  client's own localhost.

  No authentication behaviour changed. Basic and Ed25519 callers, and the
  response an uncredentialed request gets, are exactly as before; `/mcp` remains
  behind `FLAIR_MCP_OAUTH`, still off by default.

### Fixed

- **The admin Instance page no longer advertises an MCP endpoint that isn't there.** The
  Endpoints table printed `<public-url>/mcp` on every install, but that route is off by
  default — so a default install's own dashboard pointed operators at a URL that returns
  404, which reads as a broken install rather than a disabled feature. The row now shows
  "Not enabled" plus the environment variable that turns the surface on, and shows the URL
  only when the route is genuinely mounted. Nothing to do — the other rows are unchanged
  and were already accurate.

  The row renders from the state the route registration records about its own decision,
  not from a second read of the feature flag, so the page cannot drift from what is
  actually served. That matters because the flag alone was never sufficient: with the flag
  on but no issuer configured, the route still does not mount.

- **A deploy now supplies `FLAIR_PUBLIC_URL`, and proves it took effect.** A publicly-reachable
  instance served an OAuth discovery document whose issuer and every endpoint were
  `http://127.0.0.1:9980`, so remote clients followed discovery to their own loopback and no
  authorization flow could complete (#1000). `flair deploy` and `flair init --remote` now ship a
  `.env` in the component payload carrying `FLAIR_PUBLIC_URL`, taken from the target the deploy
  already resolves and verifies against; after deploying, `flair deploy` reads
  `GET <target>/OAuthMetadata` and fails if the advertised issuer is still loopback — an
  unreadable document is reported as a check that did not run, never as a pass. `flair doctor`
  reports the same misconfiguration locally, naming the file, the key and the `loadEnv`
  requirement. An existing `.env` is merged and a value you set is never overwritten; the deploy
  prints the disagreement and keeps yours, and your file on disk is never written to. The
  `flair init --remote` tarball builder had written a `.env` since April and packed an entries
  list that never contained it, so its output was discarded on every call — `.env` is now in that
  list, and the tests assert against the packed payload rather than against a file on disk. That
  builder's admin-password parameter is **removed** rather than validated: the deploy payload is
  ingested into Harper's replicated deployment record, so it must carry no credential, and
  `HDB_ADMIN_PASSWORD` could not configure Harper from a component `.env` in any case — Harper
  composes its own configuration before component env files load (#1005, #1011).

- **`flair doctor` no longer explains one unreadable key as two different wrong causes.** A key
  file that OpenSSL could not decode surfaced twice in the same report — once as `Embeddings: not
  verified` advising `Pass --agent <id>`, and once as `could not verify agent registration
  (instance unreachable: ...)` printed six lines beneath doctor's own `✓ Harper responding` tick
  (#1023). Neither was the cause: an agent had been selected, and the instance had demonstrably
  answered. The operator was sent to check firewalls and ports for a file on their own disk. The
  fix is structural rather than better wording — signing strictly precedes the request, so
  `authFetch` now raises a distinct `KeyLoadError` for the signing half only, and no caller has to
  infer from an error string whether the network was ever reached. Doctor names the file that
  failed and that it could not be parsed as an Ed25519 private key; an unrecognised failure
  reports the operation and the raw error and asserts **no** cause at all. `--agent` is suggested
  only where it can actually resolve an identity — a remedy that cannot change the outcome is now
  omitted rather than printed. Registration findings also carry the reachability the run already
  established, so `unreachable` can no longer be claimed after this run watched the instance
  respond. Key-decode failures are recognised by the crypto backend's structured error code
  across both OpenSSL and BoringSSL, whose wording for the identical failure differs.

- **`/mcp` reports its real version.** The `initialize` response hardcoded
  `serverInfo.version` as `0.1.0`, which is the string a connecting client
  displays and the one someone reads while diagnosing an incident. It now comes
  from the package version.

- **The SessionStart hook now fails quietly, and `flair doctor` notices when it stops working.** The
  hook Flair registers resolves a package binary through your Node runtime, and under a Node version
  manager globally installed packages are per-runtime-version — so a routine, unrelated runtime
  upgrade could orphan it. The hook then failed on *every* session, indefinitely, with a message that
  named neither Flair nor a remedy, and it kept doing so after Flair itself was gone (#1007). The
  registered command is now wrapped so any failure to resolve or execute produces no output and exits
  0, on every shell tested (sh, bash, zsh, dash, ksh, fish, tcsh — the previous form was broken
  outright in the last two). The adapter's own no-op-on-failure guarantee could not cover this: it
  lives inside the binary that never ran. `flair doctor` now *runs* the registered command — bounded,
  and side-effect-free via a new `FLAIR_HOOK_PROBE` mode that makes the hook answer and exit without
  touching the network — so a hook that no longer resolves is reported with a remedy instead of
  staying invisible. `flair doctor --fix` rewrites an older, loud hook in place, keeping its agent and
  instance; it never rewrites a hand-edited one and never removes a hook. `flair hook status` gained an
  **On failure** line. Agent ids and URLs are now refused rather than escaped if they contain
  characters that are not safe in a shell command.

- **An upgrade that drops the instance out of launchd now says so, instead of reporting success.**
  On macOS, `flair upgrade` and `flair restart` fall back to a plain detached start when a launchd
  operation fails. The fallback is right — a running instance beats a down one — but it leaves the
  process outside the manager that owns it, so it will not come back after a reboot, and the run
  still finished with `✅ verified: healthy, authenticated, running <version>`. Every one of those
  facts was true; none of them was the one that mattered (#1022). After a restart, both commands now
  ask launchd what it is actually running and compare it against the process serving the instance.
  A run that ends detached reports the verified facts **without** a success marker, names the job,
  says the instance will not survive a reboot, and gives the commands that restore it. A clean run
  prints exactly the line it always did.

  The launchd start also no longer waits out its full startup budget to discover a plist it could
  never have run. `launchctl load` and `launchctl start` both exit 0 for a job whose program does not
  exist, so the only symptom was a 60-second timeout naming a port — twice, once for the stop and
  once for the start. A plist records absolute paths, and switching Node runtimes moves all of them,
  so those paths are now checked before launchd is asked to do anything: a stale one fails
  immediately, naming the path that moved and the `flair init && flair restart` that re-points it.
  Likewise, the stop leg asks whether launchd is running this instance before waiting a minute for a
  process it does not control to exit. The fallbacks are unchanged; only the waiting and the
  reporting are.

### Security

- **Dynamic client registration is now off unless an operator turns it on.**
  `POST /OAuthRegister` used to accept anonymous registrations from anyone who
  could reach the instance, gated only by a redirect-URI host match — so on a
  publicly-reachable Flair, anyone could create rows in the durable, replicated
  `OAuthClient` table, each one a `client_id` that `/OAuthAuthorize` would
  subsequently honour. It now answers `403 access_denied` by default, and the
  RFC 8414 / `/OAuthMetadata` discovery documents stop advertising a
  `registration_endpoint`, because advertising one that refuses every request is
  a discovery document that misdirects.

  **This changes behaviour for anyone relying on anonymous registration.** To
  keep it, set `FLAIR_OAUTH_DCR_TOKEN` to an initial access token of 32 to 508
  characters (RFC 7591 §3.1) and have clients present it in an
  `X-Flair-Initial-Access-Token` header. Registering clients ahead of time and
  leaving registration off is the better shape where it is workable.

  That one variable is the whole interface: there is no separate enable switch,
  so enabling registration and supplying the credential that guards it are the
  same act, and "on, and open to the internet" is not a state reachable by
  forgetting a setting. A token outside the accepted length leaves registration
  **off** rather than enabling it weakly, and says so by variable name.

  Note that registration rate limiting runs in front of this gate, so refused
  attempts spend budget and a flood against a closed endpoint is answered `429`
  rather than `403`.

  The token belongs in the process environment. `flair deploy` will not generate
  a component `.env` containing it — a deploy payload is stored in Harper's
  deployment record and replicated to every node.

  RFC 7591 presents this token as `Authorization: Bearer`, which cannot work
  here: Harper's own auth layer claims that header and answers `401` before any
  Flair code runs. Hence the dedicated header. See
  [docs/auth.md](docs/auth.md#dynamic-client-registration).

- **`/mcp` now caps the request body at 256 KB.** The handler read the entire
  request into memory with no limit, and Harper imposes none on this path —
  `srv.http()` bypasses both Fastify's 1 GB `bodyLimit` and the contentTypes
  handler's configurable default. Enforcement is two-phase: an oversized
  `Content-Length` is rejected before a byte is read, and the streaming read
  aborts mid-body, so a chunked request that omits or understates the header
  cannot bypass it. This matters more here than the same pattern elsewhere
  because `/mcp` is the first surface reachable by an open population of OAuth
  clients rather than by agents we issued credentials to.

- **The OAuth endpoints and `/mcp` are now rate limited.** `/OAuthToken`,
  `/OAuthAuthorize` and `/OAuthRevoke` share a budget of 30 requests per minute
  per caller; `/OAuthRegister` gets 5 per five minutes; `/mcp` gets 120 per
  minute per verified token subject. A rejected request answers `429` with a
  `Retry-After`. On by default — nothing to configure — and no other path is
  affected.

  The counter is consumed before any credential is examined, so a `429` reveals
  nothing about what the request was carrying: a valid authorization code and a
  garbage one get byte-identical responses once a bucket is spent. No
  `RateLimit-*` headers are published on allowed requests.

  Tunable via `FLAIR_OAUTH_RATE_LIMIT`, `FLAIR_OAUTH_REGISTER_RATE_LIMIT` and
  `FLAIR_MCP_RATE_LIMIT`; `FLAIR_RATE_LIMIT=off` disables it entirely. A limit
  of zero, a negative number or a non-numeric value is refused in favour of the
  default, with a warning naming the variable — a shell that expanded an unset
  variable cannot quietly switch the control off.

  Keying is on the socket peer address. `X-Forwarded-For` is ignored unless
  `FLAIR_TRUSTED_PROXY` names how many proxy hops genuinely sit in front, since
  an instance that trusts that header without a proxy can be bypassed by varying
  it. **The limiter is per node**: on a multi-node deployment the effective
  ceiling is the limit times the node count, and counters reset on component
  reload. A cluster-shared counter would turn every counted request into a
  durable replicated write on an authentication hot path, which is a worse
  denial-of-service shape than the one being defended against. See
  [docs/auth.md](docs/auth.md) for what this does and does not protect against.

## [0.33.0] - 2026-07-31

### Added

- **`memory_store` on the server's built-in `/mcp` endpoint can set `visibility`.**
  The tool had no visibility argument of any kind, and sends `durability:
  "standard"` when the caller names none — so every memory written through that
  surface was stamped `private` with nothing the caller could pass to change it.
  An agent wired to the built-in endpoint could not write a memory another agent
  was able to read, while the stdio adapter `@tpsdev-ai/flair-mcp` exposed the
  argument all along. Pass `visibility: "private" | "shared"`; omit it and the
  durability-keyed default applies exactly as before.

  Only those two values are accepted — anything else fails the tool call rather
  than reaching the record. Visibility is a free-form string in the schema and
  the read scope tests it by exact match against `private`, so any other value,
  a typo included, reads as non-private and goes to every agent on the instance.
  Passing an unrecognised value through would write a memory the caller believes
  is owner-only that everyone can read, and silently dropping it would fall back
  to a default that is `shared` for a durable write. A misspelled argument must
  not widen who can read a memory.

- **Every memory write now reports the visibility it landed on.** The write
  response was `{ id, written, deduplicated }`, so the one field on a memory
  most likely to have been decided by a rule the writer never typed was also the
  one field the writer could not observe without a second read. It now carries
  `visibility` as well, on every surface at once: the JSON `flair memory add`
  prints, the REST write response, and the `memory_store` result on both MCP
  surfaces — including the stdio adapter's "effective visibility" line, which
  read this field all along and had nothing to read, so it always rendered
  "(server default)".

  Additive: `id`, `written`, `deduplicated` and the dedup collision fields are
  unchanged. The key is omitted, rather than reported as `null`, for a patch of
  a record written before the field existed — absent visibility reads as
  non-private, so reporting `null` there would suggest the opposite.

### Changed

- **`flair memory add --visibility` accepts only `private` or `shared`.** It
  previously forwarded whatever it was given. Because the read scope tests
  visibility by exact match against `private`, every other value — `prvate`,
  `Private`, `office` — was treated as non-private and returned to every agent
  on the instance. A typo in the flag whose entire purpose is to keep a memory
  owner-only produced a memory that was not, silently and with a zero exit code.
  Unrecognised values now exit non-zero, naming the two valid ones, before any
  write leaves the CLI.

  This retires `--visibility office`, which was a real read-scope tier when the
  flag shipped and was removed as a read leak. Nothing in the read path has
  branched on it since, so an office-stamped memory is indistinguishable from a
  shared one — `--visibility shared` is the value that means what it used to
  mean. Scripts passing it get an error naming the replacement rather than a
  tier the server stopped implementing.

- **`How Flair compares` states positions instead of scoring them.** The old
  table won every row and then admitted it omitted the rows it would not have
  won; the three concessions under it each gave with the first clause and took it
  back with the second. The table now covers the dimensions products actually
  differ on — where memories live, what memory is scoped to, orchestrator reach,
  instance-to-instance sync, in-person capture and per-agent character — with no
  qualifying clauses and no emphasis on our own column.

  SageOx is included, and it holds the row Flair loses: Ox Dot captures in-person
  meetings, standups and whiteboard sessions, and Flair has no ambient capture of
  anything that is not already text in a tool.

- **The README leads with a quick start you can copy-paste.** The lede is now two
  sentences on identity, memory and soul, and the first runnable command sits on
  line 17 instead of line 61. The quick start is a single path — install the CLI,
  init, write a memory, search it back — rather than a fork the reader has to
  choose between before they have run anything.

  Nothing was dropped. The harness diagram moved below the quick start into its
  own section, Harper moved from the opening pitch into `How it works`, and the
  Harper-component path is now a clearly-labelled second door under
  `Integration → Embedded in a Harper app (in-process)`, where it carries the
  full in-process contract it used to share with the top of the file. The
  `sudo` caveat now follows the working install command instead of preceding it.

### Fixed

- **`--durability` describes itself in `--help` again.** `flair memory add` and
  `flair soul set` both passed the intended default as Commander's second
  argument, which is the description, not the default (that is the third). So
  `flair memory add --help` rendered the option as `--durability <d>  standard`
  and `flair soul set --help` as `--durability <d>  permanent` — the word alone,
  with no indication of what the flag does or what else it takes. Both now name
  the four tiers, and `memory add` also names the visibility each one defaults
  to. Behaviour is unchanged: the real defaults were always supplied separately.

- **`scripts/flair-client.mjs` no longer folds an unparsed flag into free text.**
  `search` accepted `--limit` but never parsed it, so the flag and its value became
  part of the query — `--limit 20` searched for the literal text "<query> --limit 20"
  and still returned the hardcoded 5 results. Flags are now extracted before the free
  text is assembled, and a flag with no value, an invalid value, or one belonging to a
  different command is a hard error rather than silently becoming content.

- **A `.env` in a deployed Flair component is now actually read.** Harper does
  not load a component's `.env` implicitly — it loads env files only for
  components that declare its `loadEnv` plugin, and Flair's `config.yaml` never
  did. So a `.env` sitting next to `config.yaml` on a deployed instance was
  inert: the file arrived intact and its values never reached `process.env`. The
  visible symptom was a public deployment whose OAuth discovery document (and
  A2A agent card) kept advertising a `127.0.0.1` issuer and endpoints even
  though `FLAIR_PUBLIC_URL` was set in the component's `.env`, so no external
  client could complete an authorization flow against it (#1000, #1005).

  Nothing to do on an existing install, and nothing changes for one. A `.env` is
  optional: when the file is absent — which is the normal case for a local
  install driven by a launchd plist or a systemd unit — the plugin never fires
  and boot is line-for-line identical to before. Deployments that want to set
  `FLAIR_PUBLIC_URL` (or any other `FLAIR_*` variable) this way can now do so by
  putting a `.env` in the app root.

  Application variables only. Harper composes its own configuration before
  component `.env` files load, so Harper's own settings — `HDB_ADMIN_PASSWORD`,
  `HTTP_PORT` — must still come from the process environment, and
  `HARPER_CONFIG` / `HARPER_DEFAULT_CONFIG` / `HARPER_SET_CONFIG` are refused
  outright by Harper with a warning at boot. `.env.example` said Flair never
  read a `.env` at all; it now describes which process reads what, and where
  the boundary is.

- **The docs said reads are open unless you opt out; a bare write is `private`.**
  `docs/quickstart.md` told a first-time reader that `flair memory add
  --visibility private` was how to keep a memory owner-only and that "reads are
  otherwise open to every agent on the instance". Reads within an instance
  genuinely are open — for `shared` memories. But visibility is stamped at write
  time from durability (`permanent`/`persistent` -> `shared`,
  `standard`/`ephemeral` -> `private`), and a write naming no durability is
  `standard`, so the bare write the quickstart demonstrates lands `private`. The
  rule appeared in `flair memory add --help` and nowhere in the documentation
  tree at all.

  The quickstart now names the visibility at the moment of the first write,
  gives the durability rule as a table, and shows `--visibility shared` as the
  one-flag way to share on purpose. `README.md`, `SECURITY.md`, `DESIGN.md`,
  `docs/mcp-clients.md`, `docs/the-team.md` and `docs/troubleshooting.md` carried
  the same "private is opt-in" implicature and now state the rule. No behaviour
  changed: private-by-default for non-durable writes is the intended design, and
  the documentation is what was wrong.

- **A rewritten launchd plist is now re-read on restart.** `ensureLaunchdServiceLoaded` now unloads the service before loading it, so launchd picks up changes to the plist on disk. Previously a config change followed by `flair restart` could silently keep the old environment.

- **`flair stop` no longer reports success while a KeepAlive job respawns.** The launchd stop path now uses `launchctl unload` instead of `launchctl stop`, which both stops the process and prevents launchd from immediately restarting it. This also fixes `flair restart`, `flair upgrade`, and `flair snapshot` — all of which compose stop-then-start through the same helper.

- **Legacy launchd plist migration now validates the plist before rewriting it.** If the legacy plist does not contain the expected Label key, migration refuses with a named remedy instead of silently propagating a malformed document. The Label replacement also uses a `$`-safe function replacer, closing a latent bug that could fire if the label format ever changes.

- **`docs/quickstart.md` no longer claims one install gives you three things.**
  It said `npm install -g @tpsdev-ai/flair` provides `flair`, `flair-mcp` and the
  client library; the package declares one binary and neither of the other two as
  a dependency.

  Both the quickstart and the README now separate the two things called "MCP":
  the server's own `/mcp` endpoint, which ships inside the package but registers
  no route unless `FLAIR_MCP_OAUTH` and a public issuer are set, and the stdio
  adapter `@tpsdev-ai/flair-mcp`, which is what MCP clients are actually wired to
  and is fetched on demand via `npx` rather than installed globally.

- **`flair search --explain` now works when stdout is not a terminal.** Previously
  the flag was accepted and silently did nothing for every script, agent, CI job
  or `| less` — a non-TTY stdout selects JSON output, and the JSON path returned
  before the breakdown was ever rendered. The breakdown now rides along the JSON
  as an `_explain` object on each hit, so non-interactive callers get it too.
  Output without `--explain` is unchanged.

  The breakdown itself is also more truthful: it no longer labels a raw score
  `composite=` under the default `--scoring raw`, and it no longer reports
  `retrievalCount`, which stopped participating in the composite formula when
  usage replaced retrieval as the reinforcement signal. It now reports the
  ranking inputs the server actually returned — raw score, composite score under
  `--scoring composite`, durability, age and usage count.

## [0.32.0] - 2026-07-31

### Added

- **Deployment-shapes chooser + two new guides.** Added `docs/deployment-shapes.md` — a single-page chooser that links to the three deployment shapes: standalone local, hosted on Harper Fabric, and embedded in a Harper app. Two new guides accompany it: `docs/standalone-local.md` (full lifecycle for the default `flair init` path) and `docs/hosted-on-fabric.md` (Fabric component deployment with `flair deploy`). The third shape — embedded in a Harper app — is the pre-existing `docs/embedding-in-a-harper-app.md`.

- **Public in-process API (`new Flair(server)`).** A facade that hides internal
  implementation details (deep imports, `server.resources` keying, `.Resource`
  wrapping, `collectionResource()`, double-passing `agentId`) while preserving
  the security boundary. One handle per Harper instance, lazy resource
  resolution, agent-scoped handles via `flair.as(id)`, admin operations via
  `flair.admin`, and internal operations via `flair.internal`. The package now
  has `main` and `exports` fields so `import { Flair } from "@tpsdev-ai/flair"`
  resolves directly.

  **Breaking for deep importers.** Adding an `exports` map makes it an allowlist:
  paths under `@tpsdev-ai/flair/dist/*` no longer resolve. Import
  `@tpsdev-ai/flair` for the facade, or `@tpsdev-ai/flair/server` for the raw
  primitives; `@tpsdev-ai/flair/package.json` also remains available. This is a
  0.x release and reaching into `dist/` was never a supported path, but the
  change is called out here rather than left to be discovered at import time.

### Changed

- **The README quick start now forks Harper-native first.** Readers whose application already runs on Harper reach the in-process path in one click instead of finding it two-thirds of the way down the page, and the CLI quick start keeps its own branch immediately below — nothing was removed. Over HTTP Flair is one memory API among many; loaded as a component it is a method call with no network hop and no second service to operate, and the front door now says so.

  The same section gains an honest answer to "where does the agent key go?": the path `flair init` writes it to, what backing it up buys, what losing it costs (the identity, not the memories — recovery is `flair agent rotate-key`, which needs the admin password), and the fact that the in-process path needs **no key at all**, because identity there is asserted through the call context rather than proven with a signature.

### Fixed

- **`flair backup` routes progress output to stderr when stdout is not a terminal.** `flair backup > file.json` used to capture the progress report, producing a plausible-looking file of a few hundred bytes that was not a backup. Now the redirect produces an empty file — unmistakably not a valid archive — while default-path callers (schedulers, cron) are completely unaffected. The archive still goes to `--output` / the default path.

- **`docs/deployment.md` backup/restore commands corrected.** The documented `flair backup >` and `flair restore <` forms were wrong — backup writes to `--output`, not stdout, and restore reads a positional path from argv, not stdin. Both now match the correct forms already in `docs/upgrade.md`. A new docs-freshness lint rule (`broken-backup-restore-docs`) rejects the broken shapes repo-wide so they cannot re-enter documentation.

- **`flair init` no longer touches a legacy launchd plist that belongs to a different instance.** The pre-flair#693 `ai.tpsdev.flair` plist is a single global label — `init` now reads its `ROOTPATH` to establish which data dir it serves, and only unloads/deletes it when that matches the instance being initialised. A plist owned by another instance is left alone with a message. Errors during unload or delete are surfaced instead of swallowed.

- **The README's in-process example could not have worked.** It built the resource with `new Memory(undefined, ctx)` and called `post()` on it, which returns `405 The Memory does not have a post method implemented` — a create needs a collection-bound instance, and that mark is a private field only Harper's own `getResource()` can set. The snippet now uses the shipped `collectionResource()` / `agentContext()` seam, matching `docs/embedding-in-a-harper-app.md` and the integration fixture that is actually run against a real instance.

- **`docs/secrets-and-keys.md` named a command that does not exist.** It told readers to recover a lost or leaked agent key with `flair agent rotate <id>`, in three places; the command is `flair agent rotate-key <id>`. It also described the private key file as PKCS8 base64, when `flair init` and `flair agent add` write the raw 32-byte Ed25519 seed. Corrected because the README now links this page from its key section.

## [0.31.1] - 2026-07-29

### Added

- **Flair warns when a resource is called with no caller context.** Constructing
  a resource without a context resolves to Flair's trusted internal verdict and
  runs unfiltered — every read unscoped, every write unattributed — which is
  correct for Flair's own maintenance work and a silent, invisible mistake in an
  embedding application. The verdict is unchanged; it is no longer silent. A
  call that means to take that authority declares it with `internalContext()`
  and stays quiet; anything else logs once per process with the stack.

  The embedding guide's note that reads do not need `collectionResource()` has
  been corrected: reads do not need the collection binding, but they do still
  need the context. A search with the context argument omitted, running outside
  a request scope, returns every agent's private records — and on that path the
  resource's own gate is never consulted.

### Changed

- **A promotion or demotion applies on the principal's next request.** Admin
  lookups are cached for 60 seconds, so granting admin used to appear not to
  work for up to a minute — long enough to conclude the grant had failed and
  start changing other things. The write path now drops the cached set when it
  changes a principal, so the new status is in force immediately. The cache is
  per worker thread, so a grant applied on one thread can still take up to the
  same 60 seconds to be seen on another; the bound is unchanged.

### Fixed

- **The `admin` field on a principal now means what it says.** A principal record
  carried two fields that both read as "is this an administrator" — `role`
  (admin when the value is `admin`) and an `admin` boolean — and they were
  consulted by different parts of the system. The authorization gate read
  `role`; the CLI, the admin dashboard and every creation path used `admin`. So
  `flair principal add --admin` stored a field the gate never read and granted
  nothing, while `flair principal show` reported "admin: yes" for a principal
  that admin-only endpoints reject.

  `role` remains the authority and no existing principal's rights change. The
  boolean is now a server-maintained mirror of it: write either one through the
  `Agent` resource, `flair principal add --admin`, or agent seeding, and both
  are set together, so a record can no longer be stored saying one thing in one
  field and the opposite in the other. Every surface that decides or displays
  admin status now resolves through one shared predicate.

  Records written straight to the table (an ops-API insert, a federation merge)
  bypass that reconciliation and can still carry a mismatch. Nothing changes
  about what they are allowed to do — `flair principal show`, `flair principal
  list` and the admin dashboard now flag them as inconsistent instead of
  silently picking a side. Re-issuing the grant repairs the record.

- **A docs-freshness check that could not run no longer reports as passing
  (flair#953).** `cli-command-descriptions` introspects the CLI's command tree
  from the built `dist/cli.js`. On any machine where the CLI had not been built
  it printed "skipping", returned no failures, and the runner rendered it as
  `✓ pass` beneath a summary reading "All docs-freshness checks passed" — six
  ticks, one of which had verified nothing. The defect was never in a check; it
  was in what the runner does when a check cannot execute.

  The gate now carries three states — `✓ pass`, `⊘ DID NOT RUN`, `✗ fail` —
  through the per-check line, the summary tally and the exit code. A skip is
  never counted toward the pass total, so the tally cannot read `6/6` while
  something sat out, and the process exits `2` (distinct from `1` for real
  findings, so a wrapper can tell "your docs are stale" from "your environment
  is wrong"; both are non-zero, so CI treats them identically). Each skip names
  the unmet prerequisite and its remedy, and is emitted as a CI annotation
  rather than buried in the log.

  Two silent variants are closed at the same time. A check that examined **zero
  items** is now automatically a skip: passing checks report their corpus size
  (`✓ port-drift (26 prose docs scanned)`), so a glob or `existsSync` filter
  that empties after a rename shows up as `examined 0 prose docs` instead of
  being indistinguishable from a clean scan. And the gate refuses to report at
  all if a check fails to register, because a gate that runs zero checks
  announces success exactly as loudly as one that runs six.

  Nothing changes in CI, which builds the CLI and checks out full history before
  invoking the gate — that is the point: the gate was already passing there for
  real, and only ever went dark where nobody was looking. Running it locally
  without building the CLI first will now tell you so.

- **Five gates that could report success without checking anything (flair#953,
  sweep).** Auditing the class behind the docs-freshness skip — the absence of a
  result rendering identically to a passing result — turned up these, each
  verified against real CI logs or a reproduced failure rather than by reading
  the code:

  - **250 tests in `test/*.test.ts` were run by no CI job and no release gate.**
    Every `bun test` invocation in every workflow is directory-scoped, and a
    directory filter does not match root-level files, so twelve suites — six of
    them security-scoping (auth scoping, data scoping, content safety, key
    rotation, agent grants, backup/restore) — were never executed by CI. A bare
    `bun test`, which `CONTRIBUTING.md` tells contributors to run, does pick them
    up, so they passed locally and were enforced nowhere. Confirmed by grepping
    28.6 MB of historical CI logs for each suite's `describe()` name: zero hits
    each, against positive controls from `test/unit/` at 192 and 240 hits. They
    are now in the unit lane and all 250 pass.

  - **The implementation-term leak gate reported clean when its scan failed.**
    `grep`'s exit status was discarded with `|| true`, collapsing "grep itself
    failed" (unreadable file, argument-list overflow) into "no matches found";
    the file list was word-split, so a path containing a space was silently never
    scanned; and an empty corpus printed "No files to search." and exited 0. All
    three now fail loudly, and the file count is reported so a shrinking corpus
    is visible.

  - **`release.sh` tagged a partial publish as a complete release.** Five of the
    eight packages soft-fail on publish so a break-glass release of the core
    three isn't blocked — but the script then tagged and printed "published and
    tagged" regardless. Since the root package pins its internal dependencies at
    the exact version, a missing package is a broken install rather than a
    missing extra. The soft-fails are retained; they are now counted, named, and
    block the tag.

  - **A workspace package with no `tsconfig.json` was silently exempt from type
    checking.** It printed one "Skipping" line into a folded log and left the job
    green, so a package that lost its tsconfig in a refactor would have had zero
    type coverage with the same signal as a clean check. Exclusions are now an
    explicit allowlist, an unlisted skip fails, and a run that type-checks zero
    packages fails.

  - **`changelog-fragments check` skipped its stray-entry rule when the
    `## [Unreleased]` header was missing**, making the PR-time check strictly
    weaker than the release-time one, which refuses on the same condition. A
    mangled header passed CI and detonated mid-release-cut instead. It now fails
    where `promote` would.

  `test/unit/ci-gate-coverage.test.ts` pins these as invariants rather than as
  string matches: it enumerates every test file on disk and asserts CI reaches
  all of them, and enumerates every workspace package and asserts each is
  type-checked or explicitly excused. Adding a test directory no job runs, or a
  package nobody type-checks, fails there.

- **`flair init` no longer renumbers an instance that serves a custom port.** A
  bare `flair init` used to rewrite the port to 19926, because `--port` carried a
  commander default and commander cannot tell "the user passed the default" from
  "the user passed nothing". It was the only one of ~50 `--port` declarations in
  the CLI with a default, on the one command where a default is destructive:
  `init` is `flair doctor`'s standing suggestion and is recommended as the remedy
  in ten other places, so the command handed to an operator whose install was
  already wrong was the one that quietly moved their port.

  A bare `init` now resolves the port the way every other command does — explicit
  `--port`, then `FLAIR_URL`, then the port Harper records for that data
  directory, then the per-user config — and only reaches 19926 for a data
  directory no instance has ever been served from. An explicit `--port` still
  moves the instance, and a first-run `flair init` still lands on 19926.

- **Options a parent command owns now work on its subcommands as documented.**
  Where a subcommand redeclared an option its parent already had — `--target`,
  `--port` and `--admin-pass-file` on `flair federation sync enable|status` —
  the duplicate never received a value; it only made the flag look local. The
  duplicates are gone, the flags still work on those subcommands, and
  subcommand `--help` now lists inherited flags under a **Global Options**
  heading so nothing became less discoverable.

  A test walks the whole command tree and fails on any subcommand that
  redeclares an option name an ancestor already owns, so this class of silent
  drop cannot return the next time a subcommand grows a flag.

- **Changing a principal's admin status is restricted to administrators on every
  HTTP verb.** The principal table's per-record rules — you may only modify your
  own record, and only an administrator may change admin status — were enforced
  on one write path and not on the partial-update path, which reached the table
  with only a "is this a verified agent" check. Both paths now share one
  authorization helper, and a change to a principal's admin status is refused
  for a non-administrator on either. In-process maintenance and administrators
  are unaffected.

- **`flair upgrade --target <url> --version <semver>` silently upgraded nothing.**
  Commander matches an option against a parent command's own list before
  dispatching to the subcommand, so `--version` was caught by the program's
  global `-v, --version`: the CLI printed its own version and exited 0 without
  ever running the Fabric upgrade. The flag is now **`--flair-version <semver>`**
  (matching the existing `--harper-version`). `--version` keeps its usual
  meaning of printing the CLI version.

### Security

- **The public presence roster no longer discloses which principals are
  administrators.** The roster is readable without authentication and included a
  principal's `role`, which is also the field that denotes an administrator —
  handing an unauthenticated reader the list of privileged accounts. Admin
  principals are now presented on the roster as ordinary agents. The field is a
  display label there and nothing authorizes on it.

- **Record ownership is enforced on every write verb, for every table.** Only a
  record's owner (or an administrator) may modify it. That rule was written into
  each resource's `put()` handler — but Flair's HTTP layer maps verbs to
  resource methods one-to-one, so a rule living in `put()` was enforced on `PUT`
  and nothing else, and no resource implemented the partial-update verb. Any
  verified agent could therefore modify records belonging to another agent,
  across most of the API surface, including credentials and memory grants.

  Where a check did run, it compared the owner named in the *request body* — the
  value the caller supplied — rather than the owner stored on the record being
  written, so a request that simply omitted that field was checked against
  nothing.

  Both are now enforced in one shared guard that runs on every mutating verb and
  reads ownership from stored state. Creating records, writing your own records,
  and administrator access are all unchanged. A test enumerates the schema and
  fails the build if a table with an owner column is ever added without being
  covered, so this cannot silently regress.

- **Soul entries are owner-scoped on every write verb.** Only a principal (or an
  administrator) may write its own soul entries. That rule was enforced by a
  guard with two independent gaps, either of which alone let any verified agent
  rewrite or delete another agent's identity data: it ran on `PUT` and `POST`
  but not `PATCH` or `DELETE`, and it compared the `agentId` in the request body
  rather than the owner of the record being written — so a body that simply
  omitted the field was checked against nothing.

  Both are closed. The guard now runs on every mutating verb and resolves
  ownership from the stored record named in the path. Writing your own soul is
  unchanged, and administrators are unaffected.

## [0.31.0] - 2026-07-28

### Added

- **`assertRerankAvailable()`** — proves the reranker can serve or throws the full diagnosis, for callers where measuring or serving the *wrong* configuration is worse than failing. The recall harness's `--rerank` arm uses it; production recall deliberately does not (see Fixed, below).

- **`test/bench/corpus-profiler` — a structural profiler that measures what makes retrieval hard in a real memory corpus and emits only distributions, never text (#893).** The reranker measured Δp@3 0.000 because `corpus-v2` scores 0.976 — near enough to ceiling that a real improvement and no improvement read identically. The fix is an eval corpus matching the difficulty of real memories; the blocker is that real memories cannot leave the host, and redaction is not a viable control (it is a negative constraint — you can never prove you removed everything, and the things that leak are not secret in *form*: a codename, an internal hostname, a timestamp that correlates with a calendar entry). So the structure is measured here and the text is generated elsewhere.

  The profiler reports scale and length quantiles, near-duplicate density (each record's cosine to its nearest neighbour, the fraction above 0.8/0.85/0.9/0.95, and the sizes of the connected components those pairs form), cluster separation, embedding-space geometry (full pairwise cosine distribution, anisotropy, effective dimensionality), and vocabulary shape (type/token ratio, Zipf slope, hapax fraction). Vectors are read **as stored** rather than recomputed, so the geometry is production's; enumeration goes through `GET /Memory/` and never `POST /SemanticSearch`, which bumps `retrievalCount` on every row it returns and would have the profiler mutating the corpus in the act of measuring it. Every pairwise statistic is exact, not sampled — the profiler **refuses** above a record cap rather than falling back to a sampled nearest neighbour, which is biased low by construction and would understate the one metric the whole profile turns on.

  **What it found, size-controlled.** The obvious objection is that corpus-v2 has 251 records against the live corpus's 1080, and nearest-neighbour similarity rises with corpus size regardless of difficulty. So the comparison was run as a size sweep over both corpora, 8 seeds per point. Size does drive the number — both curves rise steeply — but the difference survives at every matched point, and one row settles it: **the live corpus at n=100 collides harder (frac with a neighbour above cosine 0.80 = 0.655 ± 0.057) than the whole of corpus-v2 at n=251 (0.506)**. A real corpus with 2.5x fewer records is more confusable than all of corpus-v2, so the size difference runs the wrong way to explain it. At matched n=251 it is 0.789 ± 0.015 against 0.506. Nothing in the profiler manufactures this: histogram bins and near-duplicate thresholds are fixed constants, and the fractions are exact per-record values rather than histogram reads.

  **One claim did not survive its control, and the correction matters more than the finding.** Type/token ratio and Zipf slope are token-count dependent (Heaps' law), and live records are 3.2x longer, so matching *record* counts hands the live corpus 4.8x the tokens. Matching *token* count instead collapses the vocabulary gap from what looked like a 20 sd effect to about 3 sd: type/token ratio 0.370 ± 0.018 against 0.425, Zipf slope −0.757 ± 0.018 against −0.690. The real structural difference is **length** — median 872 against 251 characters — and the vocabulary shape is largely downstream of it rather than an independent axis. Cluster separation shows no difference at all at matched size, and is not comparable across the full-size column because the k-means cluster count itself scales with n.

  At each corpus's own full size, with no sampling involved: **corpus-v2's closest pair anywhere is 0.936.** It contains no true near-duplicates, despite naming near-duplicate density as a design axis. The live retrievable corpus (n=1080) runs 0.919 / 0.651 / 0.261 / 0.056 at 0.80 / 0.85 / 0.90 / 0.95, with 60 records in 18 tight duplicate groups, the largest holding 15. A cross-encoder reranker's whole job is disambiguating near ties, so its Δp@3 of 0.000 measured a corpus with nothing for it to do. Profiles for both corpora are committed under `profiles/`, and `--sample-size` on both CLIs makes every comparison above reproducible rather than a number only its author can verify.

  Its safety argument is enforced mechanically rather than by review attention: `guard.ts` asserts every emitted leaf is a finite number apart from a closed `meta` enum, `profile.ts` runs it before writing so a leak fails the run rather than producing a file someone then commits, and `test/unit/corpus-profile-privacy-guard.test.ts` re-checks both the profiler's output and every committed profile on each CI run. The guard reports the path and the type of a violation and never the value — a guard that prints what it caught has published it to the terminal, the CI log, and the PR comment quoting that log.

- **Docs: `docs/deploying-on-fabric.md` — running Flair on Harper Fabric.** The hosted
  counterpart to `docs/deployment.md`, shaped as a quickstart: deploy, provision, verify,
  connect, then the traps.

  Four things it states that were previously only operator knowledge. **Ops-port
  derivation breaks on a managed Fabric URL** — the CLI derives the ops API as
  `HTTP port − 1`, so an `https` target with no explicit port resolves to `:442`; pass
  `--ops-target` (or `FLAIR_OPS_TARGET`) explicitly. **Federation is push-only** —
  `POST /FederationSync` is one-directional per call with no pull endpoint anywhere, so
  a spoke contributes up and cannot consume down, and bidirectional flow requires two
  reciprocal pairings. **The scheduled sync driver is local-only** — it installs a
  launchd job or systemd timer on the machine running the CLI and cannot be installed on
  a Fabric node. **Harper replication and Flair federation are different layers** — a
  Fabric deployment's regional nodes share one Flair instance identity via the replicated
  `Instance` table, so you do not federate your own regions to each other.

  Also documents the observability floor for a shell-less instance: `flair doctor` takes
  no `--target` and cannot be pointed at a hosted instance at all; there is no free-space,
  quota, or disk-warning telemetry on any surface; a `/HealthDetail` credential mismatch
  renders as an empty section rather than an error; and the unbounded npm cache left by
  repeated deploys ([#886](https://github.com/tpsdev-ai/flair/issues/886), open) has no
  in-product mitigation. Cross-linked from `docs/deployment.md`, `docs/federation.md`,
  and the README.

- **`flair federation sync --admin-pass-file <path>`.** Reads the admin password from a file
  instead of an inline flag, matching `flair backup`, so an unattended sync keeps the secret out of
  `ps` and shell history. The file must be owner-only (`chmod 600`) or the CLI refuses it.

- **`flair federation sync enable` — federation finally has an automatic driver.** Until now
  `flair federation sync` was one-shot and `flair federation watch` was a foreground loop that
  died with its terminal, so a freshly paired spoke synced exactly once and then silently stopped
  — which reads as a broken pairing rather than as a missing scheduler. `enable` installs a
  periodic one-shot on the platform scheduler (launchd `StartInterval` on macOS, a systemd user
  timer on Linux), with `disable` and `status` to match, mirroring `flair rem nightly`. Default
  interval 300s, `--interval` to change it, first sync runs immediately. `federation watch` is
  unchanged and remains the right tool for interactive debugging.

  The scheduler never writes a password into a unit file: it stores the *path* passed to
  `--admin-pass-file` (defaulting to `~/.flair/admin-pass` when present) and the CLI reads it at
  run time, refusing any file that is not owner-only.

- **The recall harness reports latency per query** for every config, aggregated mean ± SE across runs the same way p@3 and MRR are. A benefit number with no cost number next to it can only be read one way, and the rerank decision is benefit-per-cost.

- **Guide: embedding Flair inside an application that already runs on Harper.**
  [`docs/embedding-in-a-harper-app.md`](docs/embedding-in-a-harper-app.md) covers
  running Flair as a component alongside your own, and reaching its resources
  in-process — no HTTP, no second process, and no shell on the node. Includes
  serving many agents from one process and registering them programmatically,
  both without the CLI.

  The load-bearing detail it documents: `databases.flair.Memory` is the **table**,
  while the exported `Memory` class is the **resource**, and only the resource
  enforces authentication, read-scoping, visibility and embedding. It also spells
  out that a resource instantiated with no context resolves to a trusted
  `internal` call and runs unfiltered — correct for Flair's own maintenance
  passes, a silent trap for an embedding application.

- **Flair can now be driven entirely in-process, with per-agent scoping proven.** A Harper
  application that loads Flair as a sub-component can register any number of agents and act as
  each of them without a shell, a CLI or an HTTP hop — the shape a Fabric deployment has.
  `resources/in-process.ts` is the seam: `agentContext(agentId)` builds the context that makes a
  call act as one specific agent, and `collectionResource(Cls, context)` returns the
  collection-bound instance Harper requires for a create. Registration goes through the `Agent`
  resource, so a record gets the full Principal shape rather than a hand-copied literal, and
  Ed25519 key material can be minted with `node:crypto` alone.

  **The context object is a security boundary.** In-process identity is *asserted, not verified* —
  there is no signature, no lookup against the `Agent` table and no registration requirement, and
  `isAdmin` is asserted the same way. That is right for a caller already inside the trust boundary,
  and it means the context must be built from the app's own server-side state and **never** from
  request data: an agent id that reaches it from user input is privilege escalation with no error
  and no trace. Prefer individual agent identities over one shared app identity — a per-agent
  context costs nothing, while collapsing them loses per-agent attribution and turns N blast radii
  into one.

  `test/integration/in-process-agents.test.ts` boots a real second Harper application
  (`test/fixtures/inproc-app`, a copyable reference implementation) and pins all of it: two agents
  each write a private and a shared memory and neither can read the other's private one by search
  or by id; claiming another agent's id, naming an unregistered one, or asserting `isAdmin` each
  succeed exactly as documented; a context-**less** call resolves to Flair's trusted `internal`
  verdict and reads every agent's private records; and a fresh Harper process over the same storage
  resolves identical per-agent scope, so attribution is a property of the record rather than of the
  process that wrote it.

- **The cross-encoder reranker has a recall number for the first time in its life — and it is a null result.** Measured on the standing eval instrument (`test/bench/recall-harness`, `--corpus v2`: 251 records, 126 ground-truth queries, `--runs 3`), `hybrid=true, prefixes=on, scoring=raw` — the production default — with `FLAIR_RERANK_MODEL=jina-reranker-v2`, against the identical seeded corpus with reranking the only variable:

  | | p@3 | MRR | latency/query |
  |---|---|---|---|
  | rerank=off | 0.976 ± 0.000 | 0.946 ± 0.000 | 147.2 ± 1.1 ms |
  | rerank=on | 0.976 ± 0.000 | 0.949 ± 0.000 | 607.2 ± 3.3 ms |
  | **Δ (on − off)** | **+0.000** | **+0.003** | **+460.0 ms (4.1×)** |

  **Δp@3 is exactly zero**: across 126 queries, not one entered or left the top 3. ΔMRR of +0.003 is **+0.42 reciprocal-rank points across the whole query set** — less than the 0.5 a *single* query gains moving from rank 2 to rank 1. Per-kind it is not even consistently signed (clean +0.043, hard +0.011, against stress −0.029, trap −0.024), and per-cluster it is large gains offset by large losses (WINEMAKING +0.375, AVIATION +0.250 against LINGUISTICS −0.500, FINOPS −0.214) — the signature of near-ties being reshuffled in both directions, not of a retrieval capability improving. The cost is unambiguous: **4.1× the query latency**, +460 ms on every search.

  The rerank arm cleared all three engagement gates (`rerankCount=254`, `fallbackCount=0` per run), so this measures reranking rather than a reranker that quietly didn't run. The rerank=off arm reproduces `BASELINE.json` byte-for-byte (p@3 0.976 / MRR 0.946), and the sweep was run twice as independent invocations with identical recall figures — so the null is a property of reranking on this corpus, not of one session. **This does not decide the reranker's future**: one synthetic corpus is not the live one, and this harness's own caveats have always said an isolated result in either direction isn't the final word. It does mean the question is no longer open-ended — the feature has a number in front of it instead of behind it. `BASELINE.json` is deliberately unchanged: it holds the single production-default config a CI ratchet gates on, and reranking is off by default, so a rerank entry there could never be exercised. Full numbers, caveats and reproduction command in `test/bench/recall-harness/README.md`.

### Changed

- **Changelog entries are now one file per change under `.changelog/unreleased/`, because the shared `[Unreleased]` block was a guaranteed merge conflict on every concurrent PR — and resolving one dismissed the approvals (#835).** Every PR was required to add its entry to the same lines of the same file, so with N open PRs the last to merge conflicted N−1 times. The conflict itself was mechanical (keep both, order irrelevant); the cost was that the merge or rebase needed to resolve it **dismissed both existing approvals**, buying a full second review round for zero content change. Two PRs on one evening cost four extra review dispatches. A generic resolver also silently produced an **empty** section once, because the conflict region began below a `### Fixed` header and the surviving entries had no header left to attach to — caught only because someone printed the result.

  Contributors now add `.changelog/unreleased/<category>-<slug>.md` (categories: `added`, `changed`, `deprecated`, `removed`, `fixed`, `security`) containing the entry exactly as it should read under its `### Category` heading, leading `- ` included. Two PRs never touch the same file, so the conflict cannot occur by construction. `scripts/release.sh` assembles the fragments into a `## [X.Y.Z]` section at the version cut and deletes them; released history in `CHANGELOG.md` is untouched, and `scripts/changelog-extract.mjs` — which feeds the auto-cut GitHub release — reads the assembled section exactly as before.

  **Assembly is a pure join, deliberately.** Categories are emitted in Keep a Changelog order and fragments sort by filename within a category (never readdir order, never locale-dependent comparison), so the same fragments always produce the same bytes. Entry bodies are copied verbatim — no reflow, no re-indent, no rewrapping — because every normalisation step is a place content can be silently altered, and silent content loss is the failure this replaces. The flip side is that a fragment which is not already a well-formed list item is a hard error rather than something the tooling quietly fixes up.

  **The docs-freshness gate did not lose its teeth.** It still fails when feat/fix commits have landed since the last release tag and nothing is written down — the count is now of staged fragments rather than of lines in `[Unreleased]`, and the release-PR exception (an empty set is correct right after a promote) is unchanged. It gains two failure modes it structurally could not have before, both silent-loss vectors: a fragment it cannot parse **fails** rather than being skipped, and a hand-written entry left in `[Unreleased]` fails too, because the release step replaces that section's body and would otherwise discard it — the assembler refuses on the same condition rather than overwriting. `test/unit/changelog-fragments.test.ts` pins the property that matters: given N fragments the assembled section carries N entries, each present exactly once, mutation-checked by making the assembler drop one and confirming the suite goes red.

- **Dropped flair's seven `@node-llama-cpp/<platform>` `optionalDependencies` overrides — the upstream bug they worked around is fixed (#461, #887).** They were added because `bun.lock` used to record only the *resolving* platform's binary for a transitive optional dependency, so a lockfile generated on macOS made a Linux install resolve no addon at all and `harper-fabric-embeddings` failed at startup with `No llama-addon.node binary found`. Hoisting all seven to the top level forced every platform into the lockfile. That is no longer necessary: on bun 1.3, a package depending **only** on `harper-fabric-embeddings`, installed on macOS arm64, records all seven platform packages in `bun.lock` with their `os`/`cpu` constraints intact and installs just the matching one. The workaround outlived its bug; the entries are now pure duplication of what `harper-fabric-embeddings` already declares, and removing them changes the resolved tree on neither platform (measured: identical `du` and identical package list with and without them).

  Worth correcting the premise that motivated the audit, since it would have led to the wrong fix. These entries were described as "unconstrained overrides that defeat npm's per-platform resolution", implying all seven binaries installed everywhere. **They never did.** `os`/`cpu` are fields of the package being installed, not of the declaration that requests it — there is no way to express them in a dependency entry, so a plain version string cannot weaken anything. A clean install on macOS arm64 resolves exactly one platform package, `mac-arm64-metal`, both before and after. Removing these is correct housekeeping, not a size fix; the size came entirely from the GPU variants above. (Separately, and genuinely upstream's doing: a Linux x64 host also pulls `linux-arm64` and `linux-armv7l`, because those two packages list `x64` in their own `cpu` arrays. 11 MB, and not ours to fix here.)

  **What this costs.** Turning reranking on is now a two-step provisioning task — `npm install node-llama-cpp@3.18.1` alongside the existing GGUF download — where it previously needed only the GGUF. The peer range is pinned exactly because the rerank path depends on version-specific context-size semantics. `docs/rerank-provisioning.md` leads with both steps. With the flag on and the module absent, the provider fails open exactly as it does for a missing GGUF, logging `[rerank] WARN: reranker unavailable, recall falls back to vector order. Error: Cannot find module 'node-llama-cpp'` and returning vector order; search keeps working. That message names the missing module but not the remedy, and it is a warning on a path the operator explicitly asked for — captured here from a real server run rather than reasoned about, and left alone deliberately because `resources/rerank-provider.ts`'s failure posture is being changed concurrently under #888. `packages/flair-bench` is unaffected: it depends on `node-llama-cpp` directly, statically imports it, and is published separately.

- **`flair federation status` now says whether anything is driving sync.** It previously warned
  "one or more peers haven't merged a record in >24h" identically whether sync was running and the
  peer was unreachable, or nothing had run sync since the day you paired — two problems needing
  opposite fixes, reported the same way. Status now combines the service manager's view of the
  driver with peer contact times and names which one you actually have: driver active and healthy,
  driver active but not reaching the peer, unit files present but never loaded, no driver at all,
  or an unmanaged driver (a cron entry, a hand-written unit) that is working fine. The driver check
  is local to the machine running the CLI, so it is omitted for remote `--target`s rather than
  making a claim about a host it cannot see.

- **The release workflow's `flair-bench` staging step no longer carries `continue-on-error: true` — a failure there now fails the release, like every other package's.** The escape hatch had a real justification: `npm stage publish` categorically requires the package to already exist on the registry (`npm help stage`: "Package must exist"), and a Trusted Publisher can only be registered for a package that already exists, so a brand-new `flair-bench` could not be staged until a maintainer broke that cycle with a one-time manual publish. Until then the step was *expected* to fail, and failing the whole release on it would have been wrong. That bootstrap is done: `@tpsdev-ai/flair-bench` resolves on the registry and staged cleanly from this step at v0.30.0 (`staged with tag latest` in the run log).

  Worth stating why leaving it in place was not harmless. **`continue-on-error: true` makes a step report `conclusion: success` even when it failed** — so while it was set, the workflow's own green summary was not evidence about that step, and the only way to know whether `flair-bench` had staged or silently had not was to open the raw log. That is the shape of a gate written so it cannot fail: a control that looks like coverage and reports success unconditionally. The justification was genuine, which is exactly what made it durable — a justified exception outlives the condition that justified it unless someone goes back for it. The step keeps its own `run` block (the main staging loop runs under `set -euo pipefail` with no per-package isolation), and the surrounding comment now records the bootstrap history and its resolution rather than instructing a reader to perform work already done. `docs/releasing.md` is updated the same way: the bootstrap section is retained as history — the next brand-new package added to the release set hits the identical chicken-and-egg — but no longer reads as a to-do, and the package/approval counts move from seven to eight.

- **`node-llama-cpp` is now an optional peer dependency instead of a hard one, which takes roughly 700 MB of llama.cpp prebuilds off every Linux x64 install that never reranks (#887).** Measured on real `npm pack` + clean isolated installs, before and after: **Linux x64 1.2 GB → 504 MB**, macOS arm64 **502 MB → 460 MB**. What stops installing on Linux x64 is `@node-llama-cpp/linux-x64-cuda` (165 MB), `linux-x64-cuda-ext` (448 MB) and `linux-x64-vulkan` (76 MB) — GPU builds that were landing on CPU-only hosts because they are constrained `os: linux, cpu: x64`, which **any** Linux x64 machine satisfies whether or not a GPU exists. There is no npm way to say "only if a GPU is present", so the only lever is not pulling their parent by default.

  That parent was pulled by default for no one's benefit. `node-llama-cpp`'s **only** consumer in the published package is a single lazy `await import()` in `resources/rerank-provider.ts`, behind `FLAIR_RERANK_ENABLED`, which is off by default — embeddings have run through `harper-fabric-embeddings` since #504/#685. So every install paid for the engine and effectively none used it. A lazily-imported dependency behind a default-off flag is what an optional peer dependency describes, and the `await import()` already sat in the shape that tolerates absence.

  **`optionalDependencies` would not have worked, and this was measured rather than assumed.** Optional dependencies are *installed* by default — "optional" governs whether a failure to install is fatal, not whether the install is attempted. Moving `node-llama-cpp` there and packing it produced a resolved tree **indistinguishable from baseline** on both platforms — same `du` (502 MB macOS, 1.2 GB Linux x64) and same installed-package count (708 / 712), CUDA and Vulkan included. Only `peerDependencies` + `peerDependenciesMeta.optional` is skipped by default, and it is skipped by **both** resolvers — verified with npm 12 and bun 1.3 against the packed tarball. (This is the same finding recorded for `@harperfast/oauth` under #750, re-measured here rather than inherited.)

  **Embeddings are untouched.** They do not use the `node-llama-cpp` wrapper at all: `harper-fabric-embeddings` loads the `@node-llama-cpp/<platform>` native addon directly (its own header puts that at ~19 MB against ~250 MB for the wrapper) and declares those platform packages as its **own** optional dependencies, so they still resolve per-host, on every platform, unchanged — `mac-arm64-metal` on macOS arm64 and `linux-x64` on Linux x64 are both still present after this change. Verified end to end against the packed artifact with `node-llama-cpp` absent: `flair init` completes, reporting `Semantic search operational ✓ (paraphrase recall verified, score 1.00)`, and a memory write + semantic search round-trips.

- **The README leads with what Flair is and how to install it, in that order.** It ran to 584 lines and put `npm install -g @tpsdev-ai/flair` on line 228 — behind a competitor comparison, a feature catalogue of eighteen `###` sections, and a two-table essay comparing Flair's memory hygiene to another vendor's. A reader deciding in ten seconds whether this was for them had to scroll past all of it. Quick start now sits directly under the harness diagram and the install command lands around line 50; the feature catalogue is a single table; the comparison keeps its four differentiating rows and loses the surrounding argument.

  **Duplication resolved in favour of the quickstart.** `docs/quickstart.md` owns the step-by-step path — prerequisites, what each command prints, what to do next — and the README links to it rather than restating it. The one deliberate exception is the "never `sudo npm install -g`" warning, which stays in both: a root-owned install cannot write the embedding model into its own package directory and semantic search silently degrades to keyword-only, and the README is also the npm landing page, where a reader may never follow a link.

  **Stale claims removed rather than reworded.** The architecture tree pointed at a `plugins/` directory that does not exist (the packages have lived under `packages/` for some time); the test-coverage table advertised "203+ unit tests across 19 test files" against a suite that now has 244 test files; `flair upgrade --restart` was documented as the way to restart on upgrade when it is a deprecated no-op; the semantic-search example showed a `→ [0.67] …` output format the CLI has never printed; and `flair backup --admin-pass "$FLAIR_ADMIN_PASS"` was the headline form despite `--admin-pass-file` existing precisely to keep the secret out of `ps` and shell history. The admin-credentials bullet also said the password "is printed once and never again" — `flair init` prints the *path* to `~/.flair/admin-pass`, never the value.

  Cut in full, and recoverable from git history if wanted: the ~30-line prose comparison against another vendor's memory-curation product (REM keeps a row in the feature table and its link to `docs/rem.md`), the per-category test-coverage table, and the 25-item shipped-features checklist, now one paragraph.

### Removed

- **The cross-encoder reranker is gone — it measured Δp@3 = 0.000 at 4.1× query latency (#893).** The first and only recall measurement it ever had (#891, on the standing eval instrument: corpus v2, 251 records, 126 ground-truth queries, 3 runs, production-default `hybrid=true, prefixes=on, scoring=raw`, reranking the only variable) came back:

  | | p@3 | MRR | latency/query |
  |---|---|---|---|
  | rerank=off | 0.976 ± 0.000 | 0.946 ± 0.000 | 147.2 ± 1.1 ms |
  | rerank=on | 0.976 ± 0.000 | 0.949 ± 0.000 | 607.2 ± 3.3 ms |
  | **Δ** | **0.000** | **+0.003** | **+460.0 ms (4.1×)** |

  **Δp@3 is exactly zero**: across 126 queries, reranking moved not one into or out of the top 3. The +0.003 MRR is 0.42 reciprocal-rank points across the entire query set — less than the 0.5 a *single* query gains moving from rank 2 to rank 1 — and it is not consistently signed (clean +0.043, hard +0.011 against stress −0.029, trap −0.024; per cluster, large gains offset by large losses). That is near-ties reshuffling, not improvement. The cost is not ambiguous: **4.1× query latency**, plus ~900 MB of GGUF weights to provision before it would run at all. The arm was proven to have actually engaged (`rerankCount=254`, `fallbackCount=0` per run), so this is a measurement of reranking, not of a reranker that quietly did nothing.

  It was default-off for its entire life and had three distinct failure modes fixed in #891 before it was ever measured. Removed: `resources/rerank-provider.ts`, the rerank branch in `SemanticSearch.ts`, the `/HealthDetail` `rerank` block, the harness's `--rerank` arm, `docs/rerank-provisioning.md`, and every `FLAIR_RERANK_*` environment variable (`FLAIR_RERANK_ENABLED`, `FLAIR_RERANK_MODEL`, `FLAIR_RERANK_TOPN`, `FLAIR_RERANK_BUDGET_MS`, `FLAIR_RERANK_MIN_CANDIDATES`). Setting any of them now does nothing; no configuration change is required on upgrade, because the feature was off unless explicitly enabled. Recall is unchanged — re-measured on the same instrument after removal at **p@3 0.976, MRR 0.946, 147 ms/query**, identical to the `rerank=off` arm above.

  **What is deliberately kept.** The harness's significance rule (`test/bench/recall-harness/verdict.ts`) stays and is now wired into the prefix A/B: deltas are tested against the instrument's *resolution* (whole queries, reciprocal-rank points), not just its standard error. That rule exists because "|Δ| > SE" would have called this null result a win — every measurement this harness publishes comes back at ±0.000 variance, so any nonzero delta clears that bar. It applies to every future retrieval change. Per-query latency reporting stays for the same reason: the decision is benefit-per-cost. `resources/models-dir.ts` stays as the single source of truth for model-path resolution (embeddings still need it). The measurement itself is preserved in the harness README as the baseline a future re-attempt argues against.

- **`node-llama-cpp` is dropped from `package.json` entirely.** #887 had just made it an optional peer; with the reranker gone it has no consumer at all in the published package, so it is no longer declared in any form. Embeddings are unaffected — `harper-fabric-embeddings` loads the `@node-llama-cpp/<platform>` native addon directly and declares those platform packages as its own optional dependencies, so they still resolve per-host exactly as before. `packages/flair-bench` keeps its own direct dependency (published separately, uses the engine directly).

  **Honest scope: this does not shrink `node_modules` further — #887 already took that win.** Measured on a real isolated install of the packed tarball (macOS arm64, npm 12): 417.1 MB before #887 → 380.2 MB after it → **380.2 MB now**. An *optional* peer is not installed by default, so the bytes were already gone; removing the declaration removes the declaration, not weight. What this change does remove from the shipped package is the last dead code and documentation: `dist/resources/rerank-provider.js` and `docs/rerank-provisioning.md`, the only two files that differ (−51 KB, 32,553 → 32,551 files). The value here is that there is no longer a dependency declared for a feature that does not exist, and no provisioning doc pointing at a path that leads nowhere.

### Fixed

- **The dependency audit gate could not fail, and had been reporting green while a critical advisory shipped to users.** The `audit` job's only step was `run: bun audit || echo "::warning::…"` with `continue-on-error: true`. Two independent mechanisms each forced a pass, and they were not even redundant in the way that reads: `|| echo` already made the shell exit 0, so `continue-on-error` was dead config that could never fire. The step's `conclusion` was `success` unconditionally — for any advisory, in any package, forever.

  The warning text explained itself: *"all in harper transitive deps (unreleased v5 build)"*. That was true when it was written. **It carried no expiry, so it outlived its reason.** Measured on the tree as it stands, `bun audit` reports **14 advisories (1 critical, 5 high, 6 moderate, 2 low)** across 8 packages — and only 6 of those 14 come through `harper` at all. The critical one reaches users through a **first-party workspace package**, which is precisely the case the blanket justification asserted did not exist. Nobody had reason to re-read it, because the gate never once went red to prompt anyone to.

  **The defect was the unexpirable exception, not the exception.** Some of these genuinely cannot be fixed from this repo — a package whose latest published release is still inside the vulnerable range, or a vulnerable copy resolved inside `harper`'s pinned build where the only lever is a bun override, which is flat and global and would re-resolve that dependency for every consumer including harper's own internals. Deleting the escape hatch outright would have replaced a permanently-green gate with a permanently-red one, and a gate nobody can satisfy gets bypassed just as fast.

  So exceptions are now **enumerated, justified and dated** in `.github/audit-allowlist.json`. Each entry carries the advisory id, the dependency edge that introduces it, why it cannot be fixed here, a hard expiry, and the concrete condition that retires it. `scripts/audit-gate.mjs` fails the build on an unlisted advisory, a malformed entry, an **expired** entry, a **stale** entry whose advisory no longer appears, an entry whose recorded severity has drifted, or a `no-patch-published` entry for which a patched version has since shipped. The last two matter as much as the first: an allowlist that only ever grows is the same failure with more ceremony. Entry lifetime is capped by severity — **you cannot park a critical for a year**, the gate rejects the file if you try. When an entry expires the build fails and a human re-decides; that is the mechanism working.

  It also **fails closed**: if `bun audit` cannot produce parseable output the gate fails rather than passing, because an audit that could not run is not an audit that passed. The single degradation is narrow and deliberate — if the npm registry is unreachable, the upstream-fixability re-check emits a warning that names exactly what went unchecked and states that the enumerated, expiry and staleness checks still gated the build. An unreachable registry is not evidence of a vulnerability, and failing on it would push people to disable the gate; announcing the gap is the honest behaviour.

  **The gate was verified by making it fail, not by watching it pass** — a green run proves nothing about a check whose entire defect was that it was always green. Seven independent failure modes were each demonstrated red and then restored, including a real one: a genuinely vulnerable package added to the actual dependency tree, discovered by `bun audit` on its own, blocked by the gate with a non-zero exit. The regression guards in `test/unit/audit-gate.test.ts` were themselves mutation-checked by re-adding `continue-on-error` and `|| true` to the step and confirming each turns a test red.

  Two further checks in the same workflow had the same defect — a check that could only ever pass — and are fixed alongside it. The `resources/` compiled-artifact check piped `find` through `2>/dev/null`, so a missing or unreadable `resources/` produced no output, an empty result set and a silent pass; it now asserts the directory exists. The flair#863 ops-bind assertion ran `flair doctor … || true` and then grepped the report for a finding, so a doctor that **crashed** wrote an empty file, the grep matched nothing, and the gate passed vacuously; the exit status is now captured and an empty report fails the step. `flair doctor`'s non-zero exit is still deliberately not the signal there — a tarball-smoke environment has unrelated findings — but its silence no longer counts as a pass. This is the same lesson `release-publish.yml` recorded when it dropped `continue-on-error` from its `flair-bench` staging step: a step marked `continue-on-error` reports success even when it failed, so the workflow summary stops being evidence about that step at all.

  Full policy, including the standing rule that any advisory-only check must state in a comment what would promote it to blocking and when that is re-evaluated, is in `docs/supply-chain-policy.md` section 7.

- **CI: the Integration Tests lane no longer depends on the Ubuntu apt mirror to
  run browser tests.** `playwright install` was being invoked with
  `--with-deps`, which on `ubuntu-latest` installed nothing Chromium needs — every
  required library is already on the image — and instead pulled 21.1 MB of
  CJK/Thai/Cyrillic and X11 bitmap font packages the E2E suite never renders. When
  that mirror degraded on 2026-07-28 the step stalled past the job's 20-minute
  timeout and discarded integration and E2E CLI results that had already passed,
  reporting `cancelled` rather than `failure`. The flag is gone, Playwright's
  browser downloads are now cached on the resolved Playwright version, and the
  job's timeout has headroom. No effect on shipped code.

- **`flair init` no longer stalls for seconds detecting MCP clients, and no longer
  reports a client that is not installed.** Detection asked `npm list -g <pkg>`
  whenever a client's binary was not on PATH. That call walks the entire global
  package tree — around 0.8 s each on a warm machine, with no timeout — and
  `flair init` made up to three of them, so anyone without Claude Code, Codex and
  Gemini installed waited on a silent multi-second probe during first-run setup.

  It was also answering the wrong question. `npm list -g <pkg>` exits 0 when the
  package appears anywhere in the global tree, including as a transitive
  dependency of an unrelated global tool, and Gemini was probed with
  `@google/generative-ai` — a library, not the CLI. Flair could therefore report
  Gemini "detected" and write `~/.gemini/settings.json` on a machine with no
  `gemini` binary. In the other direction it assumed npm's default global prefix,
  so it reported "not installed" for mise / fnm / nvm / volta users.

  All four clients are now detected the same way, by looking for their executable
  on PATH, with no subprocess at all. Nothing installed is missed: `npm install
  -g` links a package's binary into the prefix's bin directory, which is on PATH
  by construction. A client whose binary is not on PATH could not be launched
  anyway, and `flair init --client <name>` still wires one explicitly without
  consulting detection.

- **`flair deploy` / `flair upgrade --target` reported a hard failure for an upgrade that had actually converged, and its own retry loop then damaged the component tree while Harper was still healing it.** Upgrading a two-node Harper Fabric cluster surfaced `Component 'flair' was deployed on the origin node but failed to replicate to 1 of 1 peer node(s): <peer> (Error: Connection closed 1006)`. Afterwards both nodes carried byte-identical component files, every schema addition was present and no data had moved: Harper's component replication is **asynchronous**, so that error was a snapshot of one instant, not a verdict — it converged on its own after the CLI stopped watching. Worse, the retry the CLI fired re-ran the whole deploy (including Harper's own `npm install` into the component directory on every node) while the previous attempt's server-side work was still in flight, and died with `ENOTEMPTY: directory not empty, rmdir '.../node_modules/<native-module>/dist'` — so the *remedy* produced the non-recoverable exit, and the reported error pointed the operator at a `node_modules` problem that only existed because the tool had retried. Four changes:

  **A convergence check now runs before anything is declared.** On a peer-replication signature, the CLI parses the peer node names out of Harper's own error (the only handle it has on cluster topology — `cluster_status` is harper-pro-only and unavailable in the OSS build this CLI ships, as `flair fleet verify` already documents) and polls each named node's `get_components` — an `admin_read` operation that *is* available — comparing the deployed component's whole file tree (path + size + **mtime**) against the origin's. A deploy whose peers converged now reports **success**, loudly saying that Harper's error resolved rather than silently swallowing it. `mtime` is load-bearing, not decoration: a peer still holding the previous release can match on every file *size* (a same-length version string, unchanged assets) and is caught only by the extraction timestamp.

  **`converged: true` requires positive, identity-guarded evidence — there is no path that infers convergence from absent evidence.** A Fabric cluster endpoint is GTM-steered to one member node, so if it happened to steer to the *failed* peer, a naive origin-vs-peer comparison would compare a node against itself and report a false all-clear — strictly worse than the false alarm being fixed. Each peer is therefore only compared against the deploy target when the two hostnames resolve to **disjoint addresses**; an overlapping, unresolvable, unaddressable (Harper's per-peer detail is free text and falls back to the literal `unknown`), unreachable, or component-less node yields `unknown`, never `converged`. Unit-tested per failure mode.

  **A retry can no longer escalate the failure class.** The reported error is now always the *first* attempt's failure: a later, different failure can only exist because the CLI chose to retry, so it describes the state the CLI's own remedy created. The later failure is still printed — hiding it would hide that the cluster may have been left worse — but explicitly labelled as a consequence of retrying, with the remedy named inline.

  **`--deploy-retries` now defaults to `0` (was `2`).** The original reasoning — "a bare manual re-run cleared it, so let the tool self-heal" — was right about the symptom and wrong about the mechanism: what clears a peer-replication error is Harper finishing its own asynchronous replication, and the re-run merely took long enough for that to happen. Retrying is not what fixed it, and it is not free — it races work that was going to succeed anyway, and it is not idempotent over Harper's component install. The convergence poll now covers exactly the window a retry was buying, without touching the cluster. Retrying stays available as an explicit opt-in for the genuine case, and is additionally gated twice: only when replication is *positively observed* not to have converged (an unknown is not a licence to re-deploy), and only once the origin's component tree has stopped changing across consecutive reads — two writers in one component directory being the best available explanation for the observed `ENOTEMPTY`, and removing the overlap being a necessary condition for any concurrent-writer explanation. Stated honestly: the CLI cannot observe *why* the remote install failed, because that happened inside Harper on another host — and it cannot make that install clean-first either, since Harper consults a component's `install_command` only when `node_modules` is already absent (`components/Application.ts` returns early — "already has node_modules; skipping install") and `deploy_component` exposes no clean/force-reinstall option. Not starting attempt N+1 on top of attempt N is the only clean-first guarantee available from the CLI side.

- **Fixed: the Harper-embedding guide's first code sample did not run.** `docs/embedding-in-a-harper-app.md`
  told readers to build a resource with `new (flair("Memory"))(undefined, ctx)` and then set
  `h.isCollection = true`. On Harper 5.1.22 that property is a getter with no setter, so the assignment
  raises `TypeError` under ESM strict mode, and omitting it yields `405 … does not have a post method
  implemented`. The Quickstart now uses the shipped `collectionResource()` / `agentContext()` helpers, and
  registration goes through the `Agent` resource rather than a hand-copied raw-table literal.

  Every claim in that guide has now been run end to end against a real Harper with Flair loaded as a
  **second component**, and the "confirm this yourself before building on it" disclaimer is replaced by
  the measurements. Two of them were wrong: `getMatch("/Memory")` misses (the slashless form hits), and
  the registry entry is an object wrapping the class, so `.Resource` is required. Per-agent scoping is
  confirmed through `SemanticSearch` — not just table search — with real embeddings attached, and the
  context-less superuser warning is confirmed on both read paths.

  The guide also now states the thing an integrator most needs: **the context object is a security
  boundary.** In-process identity is asserted, not verified, so it must be built from the app's own
  server-side state and never from request data — with the cluster consequences spelled out.

- **The recall harness's `--rerank` arm could report a clean result for a configuration it never ran.** Its own README documented the flaw: with the GGUF absent, `rerankCandidates()` fell open and the run "silently measures the non-reranked config instead of erroring". A prior fix added an engagement check, but only *after* the full measurement pass — it caught the lie having already spent the run, and the sequence was still "measure, then find out whether the measurement meant anything". Three gates now stand in front of the arm, all fatal: a preflight that refuses to spawn anything when the model key is unknown or its GGUF is absent from the models directory the spawned Harper will actually use; a pre-measure engagement check after one warm-up query, so a fall-open aborts **before any number exists**; and the existing post-measure check, kept because "engaged on query 1" does not prove "engaged on query 126". Verified against a real failure, not a simulated one: `FLAIR_RERANK_MODEL=qwen3-reranker-0.6b-q8` loads successfully (`state=ready`) and then falls back on every call inside Harper's runtime, and the pre-measure gate stops the run with the engine-level remedy rather than the "provision the GGUF" advice that would have sent an operator looking for a file already on disk.

- **The harness's own significance rule would have called that null result a win.** "|Δ| > standard error ⇒ significant" is unusable on this instrument: every measurement it has ever published came back at **±0.000** run-to-run variance, so *any* nonzero delta clears the bar — including one smaller than a single query. The rerank A/B landed exactly there (ΔMRR +0.003 at ±0.000 SE). Deltas are now tested against the instrument's **resolution** as well as its noise — Δp@3 converted to whole queries entering or leaving the top 3, ΔMRR to total reciprocal-rank points — and anything below one query is reported as *not a difference*. The report states deltas in those units, because "+0.4 reciprocal-rank points across 126 queries" cannot be misread the way "+0.003" can.

- **`/HealthDetail` could not distinguish "the migration cycle ran and found nothing to do" from "the migration cycle never ran".** Both reported `cyclePhase: "idle", lastCycleAt: null` — which is precisely why an instance skipping every migration looked healthy. The boot trigger now sets a `scheduled` phase synchronously at module load and the runner marks the cycle `done` even on the no-op path, so `idle` means one specific thing: `dist/resources/migration-boot.js` never loaded in the serving process. `flair doctor` reports that as an error, and surfaces `lastCycleError` so it can say *why* a cycle didn't complete rather than only that it didn't.

- **Fixed: the in-process by-id scoping test picked its target by a coin flip.** It selected "the first
  private record" from a `search_by_value` on the non-unique `agentId` index. Measured: that operation
  returns rows in **primary-key order**, and Harper mints `Memory.id` as a random UUID — so once an
  agent owned more than one private record, which one came back was re-decided on every run. It passed
  locally and failed in CI on the owner *control*, meaning the cross-agent assertion it exists for
  never executed in that run. An order-dependent security proof is not a proof. The test now names its
  target explicitly (the id returned by the write), verifies against storage that the record really is
  private and owned by the other agent, and then asserts the denial across **every** private record
  that agent owns rather than one lucky pick.

- **`flair init --client all` no longer reports success for Claude Code without wiring it.** Detection asked whether `~/.claude.json` existed, and that file is created when Claude Code is first *run*, not when it is *installed* — so anyone who installed Claude Code and Flair in the same sitting got Codex wired, a copy-paste snippet printed for Claude Code mid-way through a wall of output after a success line, and a run that exited 0. The user's next action was to open Claude Code, find no Flair tools, and have no reason to suspect `init`. Detection now asks the question it meant to ask — is the `claude` binary on `PATH` — which is also the test every other client here already used, and the one that matches how Claude Code is actually distributed: its native installer puts `claude` on `PATH` without registering an npm global, so the previous `npm list -g @anthropic-ai/claude-code` probe reported "not installed" for a large share of real users even after they had run it.

  **An absent `~/.claude.json` is now created rather than downgraded to a snippet.** The file is Claude Code's own, and writing a single `mcpServers` key into it is exactly what `claude mcp add` does; an existing file is still merged into, never overwritten, and unrelated top-level keys are preserved. Only a genuine read/parse/write failure — bad permissions, malformed existing JSON — now falls back to printing a snippet, and that fallback carries the underlying reason instead of the bare "no `~/.claude.json`".

  **`init` closes with a wiring summary, so a client it did not wire is still on screen when the command finishes.** The information was never missing — `wiringResults` has always distinguished "wired `~/.claude.json`" from "snippet printed (no `~/.claude.json`)" — it simply never surfaced as a difference the user could act on. The summary lists wired clients, each not-wired client by name with the reason it failed, and (under `--client all`) the clients skipped because they are not installed, which is a different outcome from a failure and is reported as one. `all` is a promise; partially keeping it silently was the defect.

- **A Flair instance's HTTP port is now read from Harper's own config in that instance's data directory, so a second instance no longer overwrites the first one's port.** `~/.flair/config.yaml` holds one port for the whole user, and `flair init --data-dir X --port P` wrote it unconditionally — so initialising a second instance silently replaced whatever port the first had recorded, and every later lookup answered with the wrong one. The lookup took no data directory at all, so there was nothing at any call site to suggest a directory was involved. This is the dual of the `--data-dir` targeting bug fixed alongside it (flair#902): that one resolved the *instance* from the wrong directory, this one resolved the *port* from a file that cannot tell instances apart. Resolution now reads `http.port` out of `<data-dir>/harper-config.yaml` — the file Harper writes at install and rewrites from its own environment on every boot — so the port travels with the directory it describes, and initialising one instance can no longer renumber another (flair#914).

  **The port comes from the process that binds the socket.** Harper already records `rootPath`, `http.port` and `operationsApi.network.port` in the data directory. A Flair-owned file recording the same three facts beside it would be a second copy of Harper-owned state with nothing to reconcile the two — and it does not stay true: boot an existing data directory on a different port and Harper updates its own config while a Flair copy keeps the old number, which is a wrong answer that looks authoritative. Reading Harper's config is a plain file read, so resolution keeps working while the instance is stopped, which is most of what `flair start`, `stop` and `doctor` are for. Harper's pre-rename filename (`harperdb-config.yaml`) is read too, so an install predating it stays addressable.

  **Existing installs are untouched.** A default install whose port lives only in `~/.flair/config.yaml` keeps working exactly as before — that file is still read for the default install, still written by `flair init` for the default install so commands without a `--data-dir` of their own keep reporting it accurately, and is never rewritten behind your back. Nothing to do, and nothing to migrate by hand.

  **A directory Flair cannot identify is now an error rather than a guess.** Asking a command to act on a `--data-dir` that Harper has never written a config into used to fall through to the per-user file — which is to say, to some other instance's port. It now refuses, names the directory and what it looked for, and says to pass `--port` or to run `flair init --data-dir <dir> --port <port>`. This only affects a non-default data directory that has never been initialised; the default install is unchanged. The refusal that keeps a port-based stop from signalling an instance it cannot be attributed to is unchanged, and now runs on a port that is guaranteed to be the one that instance is actually configured with.

  Covered by `test/unit/harper-config-port.test.ts`, which drives the real `init`, `doctor` and `snapshot` commands under a throwaway HOME, resolves two instances that must not collide, and points every stop at a listener it spawned itself so a wrong target shows up as that listener still serving — or, where the stop is meant to succeed, as it not.

- **A data directory, home directory or Flair URL containing `&`, `<`, `>`,
  `"` or `'` no longer produces a broken launchd service.** A launchd plist is
  XML, and both plist writers were interpolating values into one unescaped:
  `flair init` wrote the data directory, the install paths and the admin
  credentials raw, and `flair rem nightly enable` did the same for the home
  directory, the shim path and `--flair-url` (a URL with more than one query
  parameter contains `&`). Any of those characters made the plist malformed,
  and `launchctl` rejects a malformed plist outright — so the service or timer
  silently never registered and did not survive a reboot.

  All five XML predefined entities are now escaped through a single shared
  helper, and the generated plists are verified by actually parsing them.
  Nothing to do: re-run `flair init` (or `flair rem nightly enable`) to rewrite
  the plist for an affected install.

- **Every MCP client except one was wired to an *unpinned* `@tpsdev-ai/flair-mcp`, despite the docs promising a pin.** A wired client re-resolved the server on every agent session, so any future publish would reach it silently, with no lockfile and no review step in the path — the exact exposure `mcpServerSpec()` was written to close. Codex, Gemini, Cursor and the Claude Code array fallback were all affected; only the inline Claude Code branch in `src/cli.ts` ever wrote the pin.

  **The cause was not a failure to read the version.** The natural reading of an unpinned result is that `__pkgVersion` evaluated to `"unknown"`, and that turned out to be false: reproduced against a real global install of the published tarball under an isolated prefix and a throwaway `HOME`, `flair --version` reported `0.30.0` and `mcpServerSpec()` returned `@tpsdev-ai/flair-mcp@0.30.0` — while `wireCodex()` in the same process wrote `args = ["-y", "@tpsdev-ai/flair-mcp"]`. `src/install/clients.ts` simply hardcoded the bare package string in `flairMcpEntry()` and `tomlSnippet()` and never called `mcpServerSpec()` at all. The pin lived next to one of five call sites, and the other four never got it. It now lives in `src/lib/mcp-spec.ts` alongside the version resolution it depends on, shared by every writer — including `flair doctor --fix`, which goes through the same wire functions. Version resolution moved there too, so `--version`, the CLI↔server handshake, `upgrade --check` and the pin all read one definition; it locates the package by *name* while walking up from its own directory rather than by a fixed number of `..` hops, so relocating the module cannot silently reintroduce `"unknown"`.

  **An unpinnable spec is now loud instead of silent.** Quietly substituting an unpinned spec for a documented pin downgrades a stated security property while leaving the user believing they are pinned, which is worse than either pinning or refusing. When the version genuinely cannot be resolved, `init` and `doctor --fix` now warn before writing — naming the consequence (every session re-resolves to the latest published version) and the remedy — and `init` repeats it in its closing summary. It warns rather than refuses deliberately: an unresolvable version means a damaged install, and failing `init` there turns "MCP works, but unpinned" into "the user has nothing" without making the cause any easier to diagnose. The invariant is enforced as a test rather than a comment — any version for which the spec comes out unpinned must also produce a warning.

  **`docs/mcp-clients.md` no longer argues with itself.** It told hand-wirers to append a version and then supplied a `claude mcp add` command, a `.mcp.json` block, a Gemini block and a Codex block without one. All four now show `@tpsdev-ai/flair-mcp@<version>`; leaving the placeholder in place fails loudly at `npx`, which is the intended failure. The `SessionStart` hook snippet is deliberately still shown unpinned and now says why: `flair hook install` writes the unpinned command and `flair hook status` matches it exactly, so a hand-pinned hook reports as not wired there.

- **Fixed: the native `/mcp` write tools threw instead of writing.** `memory_store`,
  `memory_update` (with `preserveHistory`), `flair_workspace_set` and `flair_orgevent` bound their
  delegated resource by assigning `h.isCollection = true`. On Harper 5.1.22 that property is a
  getter with no setter, so under ESM's strict mode the assignment raised
  `TypeError: Cannot set property isCollection … which has only a getter` before the write was
  ever attempted. All four now go through `collectionResource()`. Read-only tools were unaffected.

  The unit doubles carried a writable `isCollection` field, which accepted the assignment and kept
  the suite green; they now reproduce Harper's getter-only accessor and private collection flag, so
  the same mistake fails a test.

- **On a provisioned install, the boot migration cycle never ran at all — silently — so every zero-touch migration, shipped and future, was skipped forever on that instance.** `resources/migration-boot.ts` resolved its data directory as `process.env.HDB_ROOT ?? join(homedir(), ".flair", "data")`. **Nothing sets `HDB_ROOT`**: Harper's own root-path environment variable is `ROOTPATH` (`harper`'s `utility/common_utils.ts` reads `process.env['ROOTPATH']`; `HDB_ROOT` exists only as a legacy *config-file key* alias in `utility/hdbTerms.ts` and is never read from or written to the process environment), and flair's own spawner exports `ROOTPATH` too. So the left branch was dead code and the migration data directory was **unconditionally `~/.flair/data`**, regardless of where the instance's real root actually was. On a default local install that path *is* `flair init`'s data dir, so it worked by coincidence. On a provisioned install — a service-managed spoke, a container, a Harper Fabric component deployment — `homedir()` belongs to whatever account the process runs as, and need not be writable at all.

  **When it wasn't, the failure was completely invisible.** `runMigrationCycle`'s first act is `acquireMigrationLock`, whose `mkdirSync(<dataDir>/.migrations, { recursive: true, mode: 0o700 })` throws `EACCES`. The runner is a library, so it correctly *reports* rather than throws — `{ ran: false, reason: "lock error: …" }` — and the boot path, its only caller, **discarded that value**. Result: no `[flair-migrations]` log marker of any kind, no `.migrations/state.json` ever written, `/HealthDetail` showing every migration `idle` under `cyclePhase: "idle"`, and pending rows never touched. Reproduced end-to-end against a real Harper: with `~/.flair` unwritable, four seeded rows needing `visibility-backfill` stayed unmigrated across restarts with not one line of output. `resources/embeddings-boot.ts` — loaded by the *same* `jsResource: dist/resources/*.js` glob — kept working throughout, because it writes no filesystem path of its own; that asymmetry was the whole diagnostic puzzle, and it was never about module loading.

  **The fix, in two halves.** *Resolution* (`resources/migrations/data-dir.ts`, new): an ordered candidate list — `FLAIR_MIGRATION_DATA_DIR` (new explicit override), `HDB_ROOT` (kept for compatibility), `~/.flair/data`, `ROOTPATH`, and the Harper root inferred from this module's own path **only** when the layout is unambiguously a deployed component (`<root>/components/<name>/dist/…`, never a source checkout or npm install) — taking the first candidate proven usable by performing the real operation the runner would perform, not a proxy check. `~/.flair/data` deliberately stays ahead of `ROOTPATH` so nothing moves on an install that already works; the later candidates exist purely to rescue one that doesn't. *Reporting*: the boot path now consumes the cycle result, and any non-benign outcome — an unresolvable data dir, tables that never became ready, a runner-reported failure, an unexpected throw — is both logged with the `[flair-migrations]` marker and recorded as a `failed` progress entry for every registered migration, which surfaces in `/HealthDetail` (with a warning), `flair doctor`'s Migrations section (counted as an issue) and `flair quality`'s `instance.migrationsClean`. The message names every path tried, each errno-bearing rejection reason, and the remedy. `single-flight` stays quiet — that is the lock guard working, and Harper boots N worker threads that each load this module.

  On the halted-migration half of the report: `runner.ts`'s documented contract ("a halted migration is retried on every subsequent boot until it clears") turns out to be **correct as written** — verified end-to-end by forcing a genuine space-blocked halt, restarting, and watching the retry clear it to `success`. It never appeared to hold only because the cycle that would perform the retry never ran. No contract or documentation change was needed.

- **A migration reported as `completed` no longer hides whether anything was actually verified this boot.** The runner short-circuits a migration whose state file records success at the running version — skipping `detect()` entirely, by design. But that state file is hand-editable, and hand-correcting it is the documented remediation for a stuck migration, so "completed because this boot checked the corpus" and "completed because a file says so" were rendered identically. The skip is unchanged; it now carries a reason (`recorded complete at <version> in <path> — not re-verified this boot`) that `flair doctor` prints, so an unverified claim is never presented as a verified one. Relatedly, a corrupt or unreadable state file still degrades safely to "nothing known yet" — but now says so instead of silently discarding every recorded outcome.

- **`docs/quickstart.md` told new users to run `flair init`, then handed them five commands that could not work.** The doc stated that first run "creates a default agent (`--agent-id local` unless you pass one)" and every subsequent step passed `--agent local`. A bare `flair init` registers no agent at all — it bootstraps the instance, prints `✅ Flair initialized (no agent registered)`, and exits without generating a keypair, running the soul wizard, or wiring any MCP client, because all four live behind `if (agentId)` and `agentId` is only ever `--agent-id`/`--agent`. There is no interactive prompt and no default. Every step from "confirm it's running" onward failed for anyone who followed the page literally. The quickstart now opens with `flair init --agent local` and states the consequence of omitting the flag.

  **Three of the doc's example outputs did not match what the CLI prints.** `flair status` was shown with 🟢/🟡/🔴 status icons (the renderer uses `✓`/`⚠`/`✗`) and with `Memory:` / `Agents:` / `Soul:` colon-suffixed labels in a layout the renderer does not produce; a bare `flair status` was described as showing "only the public health summary" when a normal local install reads `~/.flair/admin-pass` and prints the full detail. `flair memory search` was shown rendering a human-readable hit — that subcommand prints raw JSON unconditionally, and the pretty renderer belongs to the top-level `flair search`. Every block on the page has been replaced with output captured from a real `flair init` on a throwaway data directory.

  **The similarity score was described as something it is not.** "The 67% is the semantic-similarity score" — `_score` is RRF-normalized so the top result is always ~1.0 regardless of match quality, which is exactly why `_semSimilarity` exists as a separate field for the abstention floor. Reading the percentage as confidence is backwards: an unrelated memory scores 98% in a two-record store. The page now states that it is a rank score and must not be read as confidence.

  Also corrected: `flair upgrade --restart` is a deprecated no-op (restart is automatic; `--no-restart` opts out), and the "let one agent read another's memories → `flair grant`" row described a grant that open-within-org read has not required since `resolveReadScope()` landed — the row now points at `--visibility private`, which is the control that actually changes anything.

- **Every release went red in CI on a version the release script itself failed to
  bump.** `scripts/release.sh` bumped the eight `package.json` files and nothing
  else, but the version is also declared in `packages/flair-bench/src/version.ts`
  as a plain `TOOL_VERSION` constant — deliberately, since a runtime JSON import
  of `package.json` trips NodeNext import-attribute edges in the published
  `dist/`. A flair-bench test asserts the two are equal, so it failed on every
  release until an operator remembered to hand-edit the constant. It looked like
  a flake. It was not: a documented manual step that a script could perform is a
  gap in the script, and the operator was standing in for a missing line of code.

  The reason it reached CI at all is that `release.sh`'s own test step runs only
  `test/unit/`, `test/integration/` and `test/unit-isolated/`; the flair-bench
  package tests are a separate CI job. The release therefore bumped, built and
  tested green locally and only failed *after* the release branch existed, the
  changelog fragments had been consumed, and the PR was open — which is the
  expensive place to fail.

  `release.sh` now bumps that constant and stages it in the version-bump commit
  (its `git add` list is deliberately explicit rather than `-A`, so a new path
  that is not named there is silently left out of the release). A new
  `scripts/check-version-sync.mjs` backs it from both ends: `release.sh`
  **preflights** it before creating the branch or touching the changelog, so an
  out-of-sync tree costs nothing to recover from, and re-runs it after the bump
  so a missed site cannot be committed. It also runs in CI, where it does the
  part that stops this recurring — a scan that fails when *any* file outside the
  known set declares the release version, so the next version-bearing file
  someone adds is caught on the PR that adds it rather than at a release weeks
  later. The check refuses to pass when it cannot actually run: a scan that finds
  no declaration of the current version anywhere, not even in `package.json`, is
  a broken scan, and it reports that instead of a green tick.

- **The reranker could do nothing, indefinitely, while every surface reported health — and so could the benchmark built to catch that.** `rerankCandidates()` returns candidates unchanged on any failure, which is the right call for production recall (an unranked search still answers the question; turning a provisioning mistake into a total recall outage would be worse). What was wrong is that the degradation left almost no trace, so `rerankCount` sat at 0 in production with nothing to point at.

  **The health surface was structurally incapable of reporting the worst case.** `/HealthDetail`'s degradation warning read `rr.enabled && rr.rerankCount > 0 && rr.fallbackCount > rr.rerankCount` — so an install where the reranker had *never once* worked, `fallbackCount` climbing into the thousands against `rerankCount` pinned at 0, evaluated that guard to **false** and said nothing at all. The one state that most needed a warning was the one state that could not produce one. Total failure is now checked first and separately (it has a different remedy from "tune the budget"), and the decision moved into a pure, exported, unit-tested function rather than living inline in a Harper Resource no test can reach.

  **The provider now classifies, records and reports every fall-back.** `unavailable` (engine or model can't serve), `timeout` (budget exceeded) and `error` (a scoring call threw) are distinguished and surfaced as `lastFallbackReason` / `lastFallbackDetail` / `lastFallbackAt` alongside the counters. Two of the three previously incremented a counter and said nothing whatsoever. The log latch is fixed too: warnings were gated on a single process-lifetime `_warnedOnce` boolean, so the *second*, different failure in a long-running process was invisible forever — it is now once per distinct reason, with `unavailable` at ERROR level because it means someone asked for reranking and is not getting it. And the message an operator actually reads is now the actionable one: the resolved GGUF path, how the models dir was resolved, and the four ways to fix it, instead of the previous bare `reranker not ready`.

  **An unrecognised `FLAIR_RERANK_MODEL` is no longer swapped for the default behind the operator's back.** `resolveModelKey()` silently returned `jina-reranker-v2` for any unknown value *and* the status surface then reported `jina-reranker-v2` — so a typo'd model name left no trace anywhere, in either the behaviour or the diagnostics. It is now reported verbatim and rejected at init with a message naming the valid keys.

- **`flair snapshot create` and `flair snapshot restore` now stop and restart the instance named by `--data-dir`, instead of always acting on the default install.** Both commands accept `--data-dir`, and both quiesce Flair around the operation — but the helpers that did the quiescing took a port and nothing else, and resolved the data directory internally from `~/.flair/data`. A port genuinely is instance-specific, so nothing at the call site suggested a directory was involved; the bug was invisible at every one of them. The effect was that restoring a snapshot into a scratch directory to inspect it — the cautious thing to do — stopped the live instance instead, and the command reported success, because from its own point of view it had worked. `stopFlairProcess`, `startFlairProcess` and `restartFlair` now take the data directory as a required parameter, so the instance is named at the call site and the launchd service that gets resolved is the one the command is actually about (flair#902).

  **Every call site now says which instance it means, including the ones where the default was already correct.** The `flair upgrade` path names its data directory once, next to the port it resolves, and passes both down; `flair restart` passes the default directory explicitly rather than letting a helper assume it two frames away. A default that is right by coincidence is the same defect waiting for the next caller, so none of them are left to a default any more.

  **Two refusals close the paths where a data directory and a port could still disagree.** Before stopping or starting a launchd service, Flair checks that the service's own registration names the data directory being operated on, and refuses if it names a different one — this matters for installs still carrying the pre-instance-scoped service label, which is a single label for the whole login session and is therefore returned for any data directory once it exists. And on the port-based stop that Linux always takes (and macOS takes when no service is registered), a `--data-dir` outside the default install must be attributable to the process listening on that port before Flair will signal it; otherwise it refuses and says so, rather than sending SIGTERM to whatever happens to hold the port. Both refusals name the directory, the instance they found instead, and what to pass to act on the one you meant. Stops targeting the default install are unchanged.

  Covered by `test/unit/snapshot-datadir-instance-targeting.test.ts`, which drives the real commands under a throwaway HOME with a recording `launchctl` shim and asserts on the resolved service label rather than performing an actual stop. The port-attribution test points the CLI at a listener it spawned itself and asserts that listener is still serving afterwards.

- **`flair stop` could kill the process that ran it — and leave Flair running.**
  Its port-based fallback resolved targets with a bare `lsof -ti :<port>`, which
  lists every process holding *any* socket on that port, not just the listening
  server. That includes the caller's own keep-alive client connections, left by
  anything that has spoken HTTP to the instance in the same run — the
  version-handshake nudge that fires on every command, a health probe, a script's
  own `fetch`. `flair stop` then SIGTERM'd the whole list, so it could terminate
  itself before reaching Harper, or take down an unrelated client of the same
  instance. Measured directly against a live instance: `lsof -ti :<port>` returned
  the Harper PID **and** the probing process's own PID; `-sTCP:LISTEN` returned
  the Harper PID alone.

  This is the flair#800 self-SIGTERM, which was fixed in `flair upgrade`'s stop
  step and left in place everywhere else. `flair stop` and `flair uninstall` both
  signalled the unfiltered list; `flair doctor` reported it, so a "port occupied
  by PID N — Fix: kill N" line could name the doctor process the operator was
  watching. All four call sites now go through one guarded helper that filters to
  listening sockets and refuses to return this process's own PID, so the next
  kill-by-port site cannot quietly reintroduce the unsafe form.

  Found while building the flair#905 upgrade-liveness regression suite: the
  suite's teardown called `flair stop`, which killed the test runner mid-teardown
  and discarded every result it had already produced.

- **`--ignore-replication-errors` was unreachable from `flair upgrade --target`, even though Harper's own error message recommends it.** `src/fabric-upgrade.ts` built its `deploy()` options by hand and omitted both `ignoreReplicationErrors` and `deployRetries`, so the escape hatch Harper points operators at had no way through the upgrade path and `--deploy-retries` silently ran on the deploy default. Both are threaded through now, along with `--convergence-timeout <ms>` and `--no-convergence-check`, and the upgrade path's failure hint names the flag that actually helps instead of leaving the operator to find it.

- **`flair upgrade` could install the new version, fail to restart, and leave Flair
  down behind an error that named the wrong fix.** Upgrading 0.29.0 → 0.30.0 ended
  at `restart failed: Harper binary not found. Run 'flair init' first.`, exit 1,
  with the instance stopped — while the binary was present and `flair start`
  recovered a healthy install immediately. The mechanism is the package swap
  itself: `flair upgrade` replaces `@tpsdev-ai/flair`'s tree *while the CLI is
  executing out of it*, so everything after that point is old code reasoning about
  a new tree. 0.30.0 had renamed its Harper dependency `@harperfast/harper` →
  `harper` (the ~104 MB dedupe in 0.30.0), 0.29.0's resolver only ever probed the
  old name, and the name it wanted was genuinely gone. Nothing was lost — the data
  directory is never touched by a package swap — but an operator was left with a
  stopped instance and a message pointing at `flair init`, which on an initialised
  instance is the one command you least want someone running at 3am.

  Three fixes, because the single failure exposed three separate gaps:

  **The restart now runs through the newly installed CLI**, resolved from disk
  after the swap and version-checked before it is trusted. Only version N's own
  code knows how version N starts; spawn arguments, required environment, config
  templates and dependency names are all things a release may change, and the
  pre-swap process would get each of them wrong the same silent way. A CLI that
  cannot be located or confirmed falls back to an in-process restart and says so
  rather than refusing to start anything, as does an upgrade of a non-default data
  directory — `flair restart` has no `--data-dir`, so delegating one would restart
  a different instance. As defence in depth, the Harper binary is
  now located by reading the package name out of the post-swap `package.json`
  instead of a compiled-in list, so a future rename cannot reproduce this class.

  **Rollback now actually runs on a failed restart.** `docs/upgrade.md` has
  promised "install → restart → verify → rollback-on-failure, in one step" since
  flair#635, but the rollback was only ever wired to the *verification* leg — a
  restart failure went straight to `process.exit(1)`. An upgrade that installs new
  packages and then cannot start them is precisely the case the transaction exists
  for. It now reinstalls the previous version, restarts on it, and re-verifies,
  through the same path a verification failure takes.

  **The error names a remedy that works.** `Harper binary not found` now lists
  every path that was searched and points at reinstalling the package, and states
  plainly that `flair init` will not fix it. A failed restart says the instance is
  not running, that `~/.flair` was not touched, and gives `flair start`.

  Regression coverage closes the gap that let this ship: CI's upgrade lane installs
  a baseline, stops it, installs HEAD into a *fresh* directory and starts that — it
  never invoked `flair upgrade`, and nothing anywhere asserted the instance was
  still reachable afterwards. Exit status was never the gap; this failure exits 1,
  loudly. `test/compat/upgrade-restart-liveness.test.ts` performs a real
  cross-version upgrade against a real running instance in an isolated npm prefix
  and asserts `/Health` answers when it is over.

  **If you are on 0.29.0 today**, the fix cannot reach you: the code that performs
  the restart is the version you are upgrading *from*. Run `flair start` after the
  upgrade and you are on 0.30.0, healthy — see `docs/upgrade.md` for the full note.

### Security

- **Untracked `.env` and added `.gitignore` rules for `.env*` to prevent accidental secret commits.** Flair never reads a repo-root `.env`: the CLI and the Harper server both run under Node, which has no `.env` support, and Flair carries no dotenv dependency and no loader of its own — the launchd plist (`EnvironmentVariables`) and the systemd unit (`Environment=`) set variables directly. The tracked file only ever contained the non-secret `FLAIR_ADMIN_AGENTS`, but a tracked `.env` is a path of least resistance toward a future leak: anyone adding a provider key or an admin password to it meets no friction before a public commit. Added `.gitignore` rules for `.env` and `.env.*` with a `!.env.example` negation, and shipped `.env.example` as a name reference which states plainly that copying it to `.env` does not make the values take effect.

  One caveat is stated in the template rather than left to be discovered: the Bun runtime loads a repo-root `.env` on its own, so bun-executed scripts (`bun test`) do see one. That is Bun's behaviour rather than a Flair config mechanism, and it is the concrete reason an ignored, untracked `.env` matters in this repo.

- **The in-process API refuses to grant administrator access by accident.** `resolveAgentAuth` tests
  `tpsAgent` for truthiness, so a missing or empty agent id is indistinguishable from "no identity
  supplied" — which is flair's trusted `internal` verdict. Measured: `resolveAgentAuth({ request: {
  tpsAgent: undefined } })` returns `{ kind: "internal" }`, and `allowAdmin()` on that same context
  returns `true`. An embedding app whose `session.agentId` came back undefined would therefore have
  gained unfiltered cross-agent reads and writes, plus the admin-only gate, with no error and no log
  line.

  `resources/in-process.ts` is shaped so that cannot happen: `agentContext(id)` throws
  `InProcessContextError` on a missing, empty or blank id and takes **no options** (so no
  caller-influenced object spread into it can escalate); admin and the unfiltered verdict are separate
  named exports, `adminContext(id)` and `internalContext()`; and `collectionResource(Cls, context)`
  now requires its context rather than treating omission as `internal`. The privileged paths are the
  longest ones to type and are greppable by name. These are runtime guards, not type annotations — a
  plain-JavaScript embedder gets the same protection.

  The hazard itself is pinned as a test alongside the guards, so the guards cannot be simplified away
  without their justification failing in the same run.

- **`flair snapshot restore` now verifies that every entry in a snapshot lands inside the target data directory, and refuses the whole archive if any would not.** Restore extracted with node-tar's `preservePaths: true`, mirroring the flag `createDataSnapshot` sets on the create side. That mirroring was the defect: on create the input is a directory flair has just walked itself, while on restore the input is a tarball whose provenance the CLI does not control — one copied off another machine, downloaded, or handed over during a migration. With that option set, node-tar's own containment behaviour is disabled, so a snapshot that was never produced by `flair snapshot create` could write outside the directory being restored, with the privileges of the invoking user. Reproduced end to end against the real command before the fix, and each case is now a regression test in `test/unit/snapshot-restore-path-escape.test.ts` that builds genuine archives rather than stubbing the extractor — confirmed to fail against the pre-fix extraction and pass after it.

  **The flag could not simply be turned off**, which is why this is a validator rather than a one-line change. `preservePaths` is load-bearing for a documented reason: without it node-tar strips the leading `/` off an absolute *symlink target*, so an in-bounds symlink pointing at an absolute path under the data dir comes back as a nonsense relative path — silently broken. That applies to extraction as well as creation, verified directly against the pinned `tar` version rather than assumed. node-tar exposes one option for two behaviours, so `src/lib/safe-snapshot-extract.ts` keeps `preservePaths: true` for symlink-target fidelity and performs entry containment itself: a listing pass that resolves every entry path, symlink target and hard-link target against the destination, plus a filesystem-aware guard during extraction that also refuses an entry which would be written *through* a symlink — including one created earlier in the same archive, which no purely lexical check can catch. A test asserting that an in-bounds absolute symlink target still restores verbatim guards that create-side reason against regression.

  **Fails closed, and fails before doing damage.** Validation runs *ahead of* the restore path's destructive delete of the data directory, so a rejected snapshot now leaves the existing data directory untouched instead of emptying it and then refusing — previously the destructive step came first. An archive with even one out-of-bounds entry is refused whole rather than extracted-minus-the-bad-parts, and the refusal names the offending entry, the reason, and the state the data directory was left in, so the operator has a next step rather than just a diagnosis. The two sibling extraction sites (REM session snapshot restore in `src/rem/snapshot.ts`, and the session snapshot restore command in `src/cli.ts`) were checked against the same cases and are unaffected — neither passes `preservePaths`, so node-tar's own containment still applies there; they were verified rather than assumed, and deliberately left unchanged.

## [0.30.0] - 2026-07-27

### Security

- **Bumped `js-yaml` 4.1.1 → 4.3.0 and `tar` 7.5.13 → 7.5.20, clearing 7 advisories against flair's direct dependencies — and fully re-resolved `bun.lock` rather than patching the two entries in place.** `js-yaml@4.1.1` carries [GHSA-52cp-r559-cp3m](https://github.com/advisories/GHSA-52cp-r559-cp3m) (YAML merge-key chains can force quadratic CPU consumption) and [GHSA-h67p-54hq-rp68](https://github.com/advisories/GHSA-h67p-54hq-rp68) (quadratic-complexity DoS in merge-key handling via repeated aliases); both reach real parse paths, since flair parses YAML it did not necessarily author — Harper's `config.yaml` (`src/cli.ts`), bridge documents and frontmatter (`src/bridges/runtime/{yaml-loader,formats,writers}.ts`). `tar@7.5.13` carries five, including a critical one: [GHSA-23hp-3jrh-7fpw](https://github.com/advisories/GHSA-23hp-3jrh-7fpw) (critical — decompression/parse DoS via unlimited input), [GHSA-8x88-c5mf-7j5w](https://github.com/advisories/GHSA-8x88-c5mf-7j5w) (high — negative tar entry size causes an infinite loop in archive replace), [GHSA-vmf3-w455-68vh](https://github.com/advisories/GHSA-vmf3-w455-68vh) (PAX size override applied to intermediary GNU long-name/long-link headers, a tar-parser interpretation differential enabling file smuggling), [GHSA-w8wr-v893-vjvp](https://github.com/advisories/GHSA-w8wr-v893-vjvp) (process crash via PAX numeric path type confusion), and [GHSA-gvwx-54wh-qm9j](https://github.com/advisories/GHSA-gvwx-54wh-qm9j) (uncaught-exception DoS via a NUL byte in PAX path/linkpath records). Flair uses `tar` for upgrade data snapshots, REM session snapshots, and deploy tarballs (`src/cli.ts`, `src/rem/snapshot.ts`), and the restore paths extract archives whose provenance the CLI does not control, so the parser-side entries are the ones that matter most here. The lockfile was regenerated from scratch (`rm bun.lock && bun install`) instead of updating only these two entries, because a targeted update preserves every other stale transitive: the full re-resolve additionally picks up patched `brace-expansion`, `find-my-way`, and `fast-uri`, which a `--lockfile-only` bump would have left behind.

  **Deliberately stayed on the 4.x line for `js-yaml`** even though `5.2.2` is `latest`: v5 drops the default export (`import yaml from "js-yaml"` throws `SyntaxError: ... does not provide an export named 'default'`, breaking all three `src/bridges/runtime/` modules at load), and `load("")` now throws `YAMLException: expected a document, but the input is empty` instead of returning `undefined`, which would silently break the `|| {}` empty-frontmatter guards in `src/cli.ts`. Both were reproduced against `js-yaml@5.2.2` before pinning `4.3.0`.

  **`tar` lands on `7.5.20`, not the newer `7.5.22`, because of our own bake-time policy** (§1 of `docs/supply-chain-policy.md`): `7.5.21` and `7.5.22` were 5.1 and 2.3 days old at the time of this change, inside the 7-day window `scripts/check-dep-ages.mjs` enforces, while `7.5.20` was 14.8 days old. This costs nothing measurable: `bun audit` reports **byte-identical advisory sets** for `7.5.20` and `7.5.22`, verified by diffing `bun audit --json` between the two installs. The single entry that distinguishes those versions stays open either way, because it is also held by a transitive copy whose parent pins an exact version we cannot move — so taking `7.5.22` would have meant bypassing a security gate to buy a change the audit cannot see. Worth revisiting once the newer patches age out of the bake window and the upstream transitive moves.

  Scope, stated honestly: this moves flair's own **direct** `js-yaml` and `tar` to patched versions, and both were exercised against flair's real call shapes (`load`/`loadAll`/`dump` round-trips, empty-input and malformed-input handling, merge keys; `tar` create/list/extract with the exact `gzip`/`cwd`/`file`/`filter`/`preservePaths`/`portable`/`onReadEntry` options flair passes, including in-bounds symlink preservation and out-of-bounds/broken symlink filtering) — identical behavior before and after. It does **not** clear every advisory in the tree: some transitive copies are pinned exactly by their parents and are upstream-blocked, and the rest sit in the dev/workspace tree rather than the shipped server. Those are tracked privately rather than enumerated here. No `overrides` were added to make the audit number smaller — forcing a transitive resolution would green the report without changing what actually ships, and it is the same lever #750 already recorded as tried and reverted.

  Ride-along, from the full re-resolve rather than from these bumps (reproduced on unmodified `main` with the same `rm bun.lock && bun install`): `@harperfast/oauth`'s bare-`harper` peer now resolves to a distinct `harper@5.1.23` instead of deduping onto the pinned `@harperfast/harper@5.1.22`, because `5.1.23` has since been published. This is the known #750 issue, and it revises that entry's note that "bun dedupes `harper` to zero extra footprint" — that held only while `latest` matched our pin. It affects this repo's own dev/CI install only: `bun.lock` is not in `package.json`'s `files` allowlist, so it never reaches published consumers, whose trees npm resolves from `dependencies` exactly as #750 already describes. No override was reintroduced — #750 records that one was tried and reverted for breaking the clean-VM install gate.

### Added

- **`visibility-backfill` — a new always-on zero-touch migration that backfills the `visibility` field on Memory rows written before flair#509 (the durability-keyed default-visibility slice), which never stamped it at all.** Reuses flair#509's existing rule (never reinvented): `permanent`/`persistent` durability backfills to `shared`; `standard`/`ephemeral` durability, or durability that's absent/unrecognised, backfills to `private` (fail-safe — never widens access on a row whose intent can't be determined). Only rows where `visibility` is null/undefined are touched; an existing value is never overwritten, re-verified on a freshly-read record immediately before any write. `riskClass: "derived-only"` — `visibility` is recomputable at any time from `durability`, which stays on the row untouched. Matters now because the federation push filter excludes only `visibility === "private"` rows from syncing to peers, by design treating an absent `visibility` as non-private so today's single-org fleet keeps replicating pre-#509 rows unchanged — correct while every peer is this org's own fleet, but a gap once a cross-organization hub pairing lands, since a `standard`/`ephemeral` row that should never have left the instance would otherwise cross that boundary. Backfilling makes "absent" the empty set, so the existing filter stays correct as-is with zero behavior change to the filter itself. Follows `embedding-stamp`'s established migration shape (`resources/migrations/visibility-backfill.ts`): injectable table accessor, bounded `detect()`, exact `countPending()`, resumable batched `run()`, and the shared runner's generic ledger OrgEvent + completion gate — registered in `resources/migrations/registry.ts` alongside `embedding-stamp`/`graph-heal`.

### Fixed

- **A stock install shipped two full copies of Harper — ~213 MB where ~106 MB is the same engine twice — because flair depended on `@harperfast/harper` while `@harperfast/oauth` peers on the bare `harper` name.** Those are two distinct npm package names, so no package manager can dedupe across them and the peer is auto-installed alongside our pin: `npm install @tpsdev-ai/flair@0.29.0 --dry-run --omit=dev` resolved both `harper` and `@harperfast/harper`. They are permanent lockstep publishes of the same source, with the bare name as upstream's primary public one — so flair now declares `harper` at the same version (`5.1.22`), removing the second name rather than trying to reconcile two. Measured on a clean tree, an `--omit=dev` install of the packed tarball goes from **606 MB to 502 MB** and resolves exactly one Harper. Install footprint is product surface for a *local* memory layer, not hygiene: "what does it cost me to run this locally" is a question a 213 MB answer fails regardless of whether any individual byte is reachable. This also closes the ride-along noted in the dependency-bump entry above, where a full re-resolve started materialising a distinct `harper@5.1.23` under bun as well once upstream `latest` moved past our pin — that had only ever been masked by `latest` happening to match, which was never a property this repo controlled. Deliberately **not** fixed with a root `overrides` alias (`harper` → `npm:@harperfast/harper@<ver>`): #750 records that one tried and reverted — the alias target collides with the installed scoped copy, leaves npm's tree `invalid`, and makes any *second* npm operation fail (`ENOTEMPTY` renaming `node_modules/harper`, or `ERR_INVALID_ARG_TYPE`), which is what broke the clean-VM install gate. The rename has no alias and no second name, so that whole failure mode is absent by construction — verified by re-running the gate's two-npm-operation shape (global tarball install, then a second `npm install` inside the installed package dir) and confirming exit 0 with a valid tree. Both Harper package names stay probed wherever flair resolves a Harper it did not install itself — `harperBin()` (`src/cli.ts`), `resolveHarperBin()` (`src/deploy.ts`), `resolveStagedHarperVersion()` / the declared-version read in `src/fabric-upgrade.ts`, and the compat lanes' spawn helper — because `flair upgrade --target` stages a *published* flair version and every release before this one declared the scoped name; bare is always preferred when both are present (#870).

- **`--ops-bind` was accepted and had no effect, and `flair doctor`'s ops-bind finding could not be cleared by any documented means — on Linux, `flair restart` silently re-bound the Harper ops API to all interfaces and made it stick.** Every `flair restart` / `flair upgrade` (and, before that, every `flair start` on a build older than the flag) went through a direct Harper spawn that set neither `HARPER_SET_CONFIG` nor `OPERATIONSAPI_NETWORK_PORT`. Harper records the pre-`HARPER_SET_CONFIG` value of every key that variable force-sets (`state.originalValues` in `<rootPath>/backup/.harper-config-state.json`) and **restores** those originals on the next boot where `HARPER_SET_CONFIG` is absent — and the original it had recorded was a **bare port number**, because `flair init` set `OPERATIONSAPI_NETWORK_PORT` to a colon-free port alongside the correctly host-qualified `HARPER_SET_CONFIG` block. A bare number is Harper's all-interfaces form, so the first restart after a correct `flair init` reverted `operationsApi.network.port` in `harper-config.yaml` from `127.0.0.1:<port>` to `<port>` and re-bound the ops API to `*:<port>` — permanently, since the reverted value is what every later boot then read. macOS installs were masked by the launchd plist (which does carry `HARPER_SET_CONFIG`); the direct spawn is what a Linux user gets. The same shape is why `--ops-bind` looked ignored: re-running `flair init` on an already-running instance skips the Harper spawn entirely, so the flag never reached a spawn, and the restart that followed reverted the bind anyway — leaving `flair doctor`'s printed remedy (`flair init && flair restart`) unable to clear its own finding. Fixed at the spawn: one shared builder (`buildDirectSpawnEnv`) now constructs the env for **both** direct-spawn sites — they had drifted, which is how one of them came to omit the variable — and always emits the host-qualified `host:port` form through a single renderer (`opsNetworkPortValue`) shared with the `HARPER_SET_CONFIG` block, so the two channels can no longer disagree and no bare value is ever latched as a restore-to original. `flair init` now also persists `opsPort`/`opsBind` to `~/.flair/config.yaml`, and bind resolution reads it (`--ops-bind` flag > `FLAIR_OPS_BIND` > persisted `opsBind` > `127.0.0.1`): the spawns behind `start`/`restart`/`upgrade` have no `--ops-bind` flag of their own, so without a persisted value a deliberate `--ops-bind 0.0.0.0` would have been reverted to the loopback default by the next restart — the widening escape hatch was as broken as the narrowing default. `writeConfig` preserves both keys when an unrelated caller rewrites the file (e.g. `flair doctor --fix` correcting a drifted HTTP port). A new hard gate in the install-from-tarball CI lane — the only lane that exercises the direct spawn a Linux user actually gets — asserts against the real listening socket (`ss -ltn`) that a stock `init` + `restart` binds loopback and that doctor's finding is absent, that `--ops-bind 0.0.0.0` genuinely widens and survives a restart, and that `--ops-bind 127.0.0.1` narrows it back (#863).

- **`flair rem candidates`/`promote`/`reject` 404'd on every call — the `MemoryCandidate` table had no REST surface at all.** `schemas/memory.graphql` declared `MemoryCandidate` with `@table` but no `@export` and no resource file, so `POST /MemoryCandidate/search_by_conditions` (and the by-id `GET`/`PUT` the promote/reject flow uses) had nowhere to route. Added `@export` plus a new `resources/MemoryCandidate.ts`, modeled on the existing identity-gated resource classes (`resources/Relationship.ts`/`resources/MemoryGrant.ts`): verified agents, admins, and trusted internal calls pass; anonymous HTTP is denied on every verb. Reads are scoped `"owner-only"` — an agent sees only its own candidates, never org-wide — since a candidate is an unreviewed draft distillation that must not be readable before a deliberate promote/reject decision. Registered in `resources/record-types.ts`'s `RECORD_TYPES` registry (`readScope: "owner-only"`, `remEligible: false`, `federation: "excluded"` — not in the federation push table list).

- **The zero-touch migration runner's shared corpus envelope made a later `count+full-envelope` completion gate read an EARLIER migration's own legitimate writes as corruption.** The corpus-wide source-field hash envelope (flair#695 invariant IV) was computed once per boot cycle, before the *first* migration's first write — correct while no registered migration wrote a SOURCE field, which stopped holding the moment `visibility-backfill` (above) registered: it stamps `visibility` (a Memory SOURCE field) ahead of any schema-additive migration in the same cycle, so that migration's completion gate compared its post-state against the stale pre-cycle baseline and spuriously halted with `completion gate failed: rowsRemaining=0, hash envelope mismatch` (observed on PR #845's CI: the synthetic-migration e2e integration tests and the upgrade-from-npm-stable lane, where `visibility-backfill` completed and then `synthetic-ci-schema-stamp` halted). `resources/migrations/runner.ts` now tracks envelope staleness across the cycle — conservatively: any migration that wrote (or, on a mid-batch throw, may have written) rows marks the baseline stale — and re-baselines with a fresh full-corpus envelope immediately before a `count+full-envelope` consumer starts, still strictly before that migration's own first write, which is exactly the invariant's wording ("computed before first write and after completion; must match") scoped to the migration whose gate actually consumes it. A genuinely concurrent source-field mutation *during* the gated migration still halts it (regression-tested — the gate is not weakened), and a cycle with no full-envelope consumer after a writing migration (every production cycle today: `embedding-stamp`, `graph-heal`, and `visibility-backfill` are all `derived-only`) never pays for a second corpus walk.

- **`flair rem nightly enable` printed a green "scheduler enabled" headline even when activation failed, and `flair status`/`flair rem nightly status` kept repeating the claim afterward — with no way to detect the failure from an exit code.** In any session without a systemd user bus (ssh without lingering, a container, CI), `systemctl --user enable --now flair-rem-nightly.timer` exits nonzero with `Failed to connect to bus: No medium found` — `enableScheduler()` (`src/rem/scheduler.ts`) already captured that failure as `loadResult`, but the CLI (`src/cli.ts`) printed the success headline unconditionally, first, and only reported the nonzero code in a line underneath it, with `process.exit` never called — so scripts saw exit 0 for a scheduler that had nothing scheduled. Both scheduler-status surfaces had the same shape: `schedulerStatus()` and the `/HealthDetail` REM block (`resources/health.ts`) both inferred "enabled" from the timer/plist file existing, which a failed `enable` still writes. Fixed at the root: `formatEnableReport()` and `formatStatusReport()` (new, `src/rem/scheduler.ts`) only print a success headline when activation is actually known to have succeeded, `flair rem nightly enable` now exits nonzero on activation failure, and a new genuine active-state query (`launchctl print` / `systemctl --user is-active`, sync for the CLI and a non-blocking async form for the Health endpoint) replaces the file-existence check in both `schedulerStatus()` and `resources/health.ts`'s `nightlyEnabled`. The bus-connection failure now also names its own remedy inline (`loginctl enable-linger <user>`) instead of surfacing a bare error the operator has to go research.

## [0.29.0] - 2026-07-26

### Security

- **The MCP server reference written into client configs is now pinned to the installed version.** `flair init` previously wired `npx -y @tpsdev-ai/flair-mcp`, which re-resolves to whatever is currently published on *every* agent session — so a single bad publish would reach every wired user silently, with no lockfile and no review in the path, and a yank would not help because unpinned clients keep resolving latest. Clients are now wired to `@tpsdev-ai/flair-mcp@<version>` (the running CLI's own version; the two ship in lockstep), so a wired client keeps running the version that was current when it was wired and moving forward is a deliberate act. The `init` MCP smoke test now exercises that same pinned spec rather than resolving latest independently. Falls back to the unpinned form only when the version cannot be read — the same condition under which `--version` reports `unknown`.

### Changed

- **Removed the `specs/` directory** (12 planning docs — `FLAIR-1.0-SPEC.md`, `FLAIR-BRIDGES.md`, `FLAIR-CONTENT-SAFETY.md`, `FLAIR-DEPLOY.md`, `FLAIR-NIGHTLY-REM.md` + its two slice docs, `FLAIR-REEMBEDDING.md`, `FLAIR-XAA.md`, `AGENT-CONTEXT-TIERS-B-task-reset.md`, `N8N-NODE-q3qf.md`, `N8N-ED25519-q3qf-followup.md`). Planning docs now live as GitHub issues; reference docs live in `docs/`, `DESIGN.md`, and `CONTRIBUTING.md`. Every in-tree reference to a deleted spec path was repointed: bridge contract references now point at `docs/bridges.md` (now the authoritative contract, which now carries the full contract and states its own authority); REM references now point at `docs/rem.md` and `docs/notes/rem-ux.md`; n8n spec links (which pointed at absolute GitHub URLs that would 404) became plain prose; comments citing a slice spec + section for deferred/in-flight work (e.g. `§3A`, `§3B`, `§3C`) kept the section and issue number (#707) and dropped the dead file path. Historical `CHANGELOG.md` entries were left untouched — they correctly describe files that existed at the time.

### Fixed

- **Citation-on-write now validates cited ids against the writer's read scope, per the locked flair#775 design's read-scope condition.** A `usedMemoryIds` entry the writer cannot read (another agent's `visibility: "private"` memory) is dropped identically to a nonexistent id — same silent no-op, same code path, no change to the write response — so a citation only ever credits memories within the citing writer's own read scope (`resources/usage-recording.ts`'s `recordCitations()` now resolves the writer's scope once per batch via the same `resolveReadScope` every cross-agent read path uses, then checks each cited id's raw record against it; scope-resolution failure drops the whole batch, fail-closed). `POST /RecordUsage` is intentionally unchanged — it remains the deliberate cross-agent "I used this" contract, and the asymmetry is now documented at both sites. Comment-only ride-along: `schemas/memory.graphql`'s stale `usageCount`/`MemoryUsage` doc pointers now name the real writer (`resources/usage-recording.ts`'s `recordUsageContribution()`) instead of the pre-extraction `resources/MemoryUsage.ts`/patchRecord description.
- **Docs claimed `claude mcp add` writes to `~/.claude/mcp.json`; it actually writes to `~/.claude.json`.** Corrected in `docs/mcp-clients.md` and the cross-orchestrator cast recording (`docs/assets/flair-cross-orchestrator.cast`) (#828).
- **Bootstrap never reported the running Flair version, so an agent talking to a stale checkout could reason an entire session against a months-old server without knowing it.** `resources/mcp-tools.ts`'s `bootstrap()` now includes `flairVersion` in the response body, resolved from the running `package.json` via the same `resolveVersion()` pattern used by `Presence.ts` and `AdminInstance.ts` (#831).
- **No entry point told a newcomer (human or agent) where the code lives or how to check they are current.** Added root `AGENTS.md` with three sections: currency check (bootstrap flairVersion, `flair --version`, git ahead/behind), repo map (server code is in `resources/` not `src/`), and a where-to-look-first table. An agent 488 commits behind once checked `src/resources/`, found nothing, and reported federation did not exist — while `resources/Federation.ts` sat one directory up (#832).

- **`flair rem rapid` on a stock `flair init` install failed with `Reflection error: No generative backend configured` before users could find the config recipe.** README's REM introduction now explicitly states that a configured generative backend is required and links to [`docs/rem.md`](docs/rem.md). `docs/rem.md` now opens with a prerequisite warning calling out the error and pointing to the Configuration section before any command listings (#829).
- **`flair doctor`'s ops-bind remedy prescribed the one command that could break admin auth on a working install.** When the ops API is bound to all interfaces, `flair doctor` told operators to fix it by re-running `flair init` — but `flair init` unconditionally generated a brand-new random admin password and overwrote `~/.flair/admin-pass` on every run, including a re-run against an install that was already bootstrapped and working. Harper's `HDB_ADMIN_PASSWORD` env var only seeds a *brand-new* install's user record — it does not rotate an existing user's stored password hash on every boot (the admin-pass file is bootstrap-only), so overwriting the file desynced it from what Harper actually had persisted, and the very next ops-API call in that same `flair init` run (seeding the agent) failed with a 401 "Login failed" — breaking working auth on an install that had nothing wrong with its credentials, and bare `flair status` then silently dropped its detail panels. `flair init` is now idempotent with respect to the admin password (`resolveInitAdminPasswordSource`, `src/cli.ts`): when no explicit `--admin-pass`/`--admin-pass-file`/env var is given, an existing `~/.flair/admin-pass` file is reused instead of being regenerated, so re-running `flair init` can never desync it from Harper's stored credential. Doctor's printed remedy now also spells out `flair init && flair restart` (a restart is what actually applies the loopback rebind) and notes the existing password is preserved (#827).
- **The reranker ignored `FLAIR_MODELS_DIR` (GGUF resolved from a hardcoded `<cwd>/models`), silently failing open to vector order in any deployment where Harper's cwd wasn't the models location — and the recall harness's `--rerank` arm could measure a NON-reranked run while labeling it reranked.** `resources/rerank-provider.ts`'s `ensureInit()` now resolves the reranker GGUF through the same `resolveModelsDir()` the embedding engine uses (`FLAIR_MODELS_DIR` → `<ROOTPATH>/models` → `<cwd>/models` backward compat → `~/.flair/data/models`; extracted unchanged to a shared `resources/models-dir.ts`, re-exported from `embeddings-provider.ts` for existing consumers), so the "provisioned alongside the embedding GGUF" contract from `docs/rerank-provisioning.md` actually holds by construction, and the not-found error now reports the full resolved path instead of a bare `models/<file>`. Production fail-open behavior is unchanged (a rerank error still never blocks recall) — what changed is that the recall harness (`test/bench/recall-harness/run.ts`) no longer *inherits* it as fictitious measurement: the `--rerank` arm now pins `FLAIR_RERANK_MODEL=jina-reranker-v2` (the rank-pooling model that actually serves inside Harper; caller override respected) and, after measuring, asserts engagement against the same spawned Harper's `/HealthDetail` rerank diagnostics — failing loud (nonzero exit, with state/model/counts/error in the message) if the reranker was enabled but never engaged (`state≠ready` or `rerankCount=0`), instead of publishing vector-order numbers under a "rerank" label (#815).

## [0.28.0] - 2026-07-24

### Fixed

- **Semantic recall can silently degrade on a store re-embedded under an older Harper, and now self-heals on upgrade.** When the corpus is re-embedded in place (every row rewritten via `PUT /Memory`, as the `embedding-stamp` migration and `flair reembed` both do), an *older* Harper's *incremental* HNSW graph update left stale/asymmetric reverse edges — so a fresh index of the exact same vectors finds the true nearest neighbors while the mangled live graph does not, collapsing recall precision. The stored vectors are correct; only the on-disk graph is stale. This is historical: the bundled Harper (`@harperfast/harper@5.1.22`) already fixes that incremental-update path (its `index()` reconstructs the prior vector from the stored node and does the reverse-edge cleanup the old build skipped), so current writes no longer cause it — the corruption just persists on disk in stores re-embedded under the old engine. Fixed entirely flair-side by declaring the embedding index's `M` parameter explicitly (`@indexed(type: "HNSW", M: 16)` — `16` is Harper's own default, so this is a zero behavior/graph-quality change): the persisted index descriptor on every existing install was written with no options, so it now structurally differs from the schema, and on the first boot after upgrade Harper clears the graph store and rebuilds it **cleanly from the already-correct stored vectors** — no re-embed, no data rewrite. Version-agnostic: it repairs any store carrying a graph corrupted by an older engine, regardless of the Harper now running. The rebuild runs once per instance (the descriptor is then persisted to match); vector search briefly returns 503 during it (~seconds at a few thousand rows) while keyword/direct reads keep serving. A new verify-only `graph-heal` migration confirms recall is healthy after the boot (a canary self-recall check) and records a structural-only ledger OrgEvent so the heal is auditable and version-gated. Guard comments in `embedding-stamp.ts` and the `flair reembed` path document the prudent, version-independent default: pair any bulk re-embed with a structural graph-rebuild trigger rather than relying on the engine's incremental HNSW updates, and don't use `MemoryReindex._reindex` for graph correctness (it re-PUTs the same vector through the incremental path and rebuilds nothing).
- **A stock `npm install -g @tpsdev-ai/flair` pulled the entire React Native toolchain into every server install.** `@harperfast/harper`'s SQL engine dependency `alasql` ships `react-native-fs` as an `optionalDependency` (for its browser/React-Native mode), and npm installs optionals by default — so every server install dragged in `react-native` + `@react-native/community-cli-plugin`, `dev-middleware`, `chromium-edge-launcher`, `babel-jest`, etc. That branch is dead code on a server (guarded by a `navigator.product === 'ReactNative'` check never true under Node). Fixed with a root `overrides` entry aliasing `react-native-fs` to the tiny inert `empty-npm-package` (no scripts, 362 bytes). Verified on a clean isolated Linux install: `react-native` is no longer present in the tree (2 install dirs → 0) and the React-Native package subtree is dropped. (Honest scope: the transitive deprecation-warning count and total on-disk size are dominated by other deps + the native `node-llama-cpp`/embedding-model prebuilds and are effectively unchanged — this fix removes the *React Native* dead weight specifically, not the whole install's footprint.)
- **Every flair install also carries a second, differently-versioned copy of Harper — assessed a `harper` override and reverted it after it broke the clean-VM install gate.** `@harperfast/oauth`'s `peerDependencies` declares bare `harper` (a distinct, identically-sourced npm publish of the same Harper codebase under an unscoped name) rather than the scoped `@harperfast/harper` flair already bundles — npm's peer auto-install then materializes a full second `node_modules/harper` at a different, uncoordinated version (`5.1.23` vs our pinned `5.1.22`). A root `overrides` entry pinning `harper` to `npm:@harperfast/harper@5.1.22` was added and initially verified via `import()` smoke test and the full `@harperfast/oauth` unit + e2e suite — but the CI clean-VM gate (a real `npm install -g` global install followed by a nested `npm install --no-save @node-llama-cpp/linux-x64@3` inside the installed package dir, reproducing on Linux only) caught what those suites didn't: the `harper` override left npm's dependency tree in an `invalid` state (its `npm:`-alias target collides with the already-installed `@harperfast/harper` copy at the same physical location), and any *second* npm operation against that already-reified tree fails — `ENOTEMPTY` renaming `node_modules/harper` with the override unscoped, `ERR_INVALID_ARG_TYPE: "from" ... undefined` with it scoped to `@harperfast/oauth` alone, and the same `ERR_INVALID_ARG_TYPE` with both overrides present together. Isolated on Linux (three override-isolation runs against the real dependency tree: `react-native-fs` alone survives the nested install cleanly, `harper` alone fails, both together fail) — root cause is the override itself, not an interaction with `react-native-fs`. Since this override was already noted above as not reducing on-disk footprint under npm on its own (bun dedupes `harper` to zero extra footprint with or without it — confirmed removing the override changes `bun.lock` by exactly the one override line, nothing else), **dropped rather than fought**: the fragility isn't worth it for a dedup that only ever helped the npm side cosmetically. Full elimination under npm still needs the upstream fix (`@harperfast/oauth` peering on `@harperfast/harper` instead of bare `harper`) — left as a follow-up, unchanged from before.
- Assessed and **declined** moving `@harperfast/oauth` to `optionalDependencies`/`peerDependencies` of flair itself (the issue's higher-risk suggestion, since `FLAIR_MCP_OAUTH` is default-off): empirically verified neither optional nor peer deps are skipped by a plain `npm install` in current npm (peers/optionals both install by default unless the consumer explicitly passes `--omit=optional`/`--legacy-peer-deps`, which the issue already ruled out as a blanket recommendation since it would also skip legitimate `node-llama-cpp` native prebuilds). Reclassifying oauth would add real risk (its own `harper` peer chain, MCP-oauth code paths) for zero install-size benefit, so left as-is (#750).
- **The cross-encoder reranker (`FLAIR_RERANK_ENABLED`) errored on every call against real production data and silently no-op'd (fail-open masked it — `rerankCount` stayed 0, `fallbackCount` climbed).** Found running the OPS-RERANKER-INTEGRATION §6 live-corpus gate against rockit (#811). Two compounding root causes, both fixed in `resources/rerank-provider.ts`: (1) **context overflow** — the offline pilot's 16-doc fixture used short synthetic prose, but real memory content routinely exceeds either model's small context window; every (query, doc) pair is now truncated to a context-derived token budget (char pre-cut + exact tokenizer-level cut) before it ever reaches the engine, making the `rankAll` "input lengths... exceed the context size" throw effectively unreachable instead of routine. (2) **stale config** — `ensureInit()` used to cache which model was loaded PERMANENTLY on first success/failure, so a later `FLAIR_RERANK_MODEL` change had no effect until process restart ("configured model X, served model Y" could persist silently); config is now re-validated on every call and the engine reinitializes when it changes. Also flipped the **default model to `jina-reranker-v2`** (its rank-pooling path completes inside Harper) — the previous default, `qwen3-reranker-0.6b-q8`'s generative yes/no path, reliably returns empty logits inside Harper's resource runtime (a separate, previously-documented dual-native-backend limitation truncation alone doesn't fix) and is now marked experimental, kept available but not default. Fail-open behavior is unchanged (a rerank error still never blocks recall); `health.ts`'s `rerank.{state,rerankCount,fallbackCount,lastLatencyMs}` surface is unchanged in shape.

## [0.27.1] - 2026-07-23

### Fixed

- **The `embedding-stamp` migration's completion gate could halt forever on stores where every row already carried the current embedding-model stamp.** On a store whose rows were written under an older flair/Harper release and later rewritten via `PUT /Memory` (crossing a Harper minor-version boundary at boot), the migration's in-process pending-count query could report every row as still pending even though a direct record read showed each one already correctly stamped — root-caused to `embeddingModel` being an `@indexed` attribute: Harper's non-negated `not_equal` leaf condition reconstructs its match target from the (on such stores, stale) secondary index key rather than the live record, while the equivalent ops-API query reads the live record and returns the correct count. Fixed at the root by switching the query to the `not_equals` negated-comparator form, which Harper resolves to bypass the secondary index and scan primary-store records directly — immune to any index/record divergence, and behaviorally identical for genuinely-stale rows. Added a completion-gate safety net (opt-in via a new optional `Migration.recheckPending()` hook): before halting on a nonzero pending count small enough to check exhaustively, the runner re-verifies every claimed-pending row by a direct per-id read and, if all are already correct, logs a loud WARN and passes the gate instead of halting on what was really a counting artifact (#807).

## [0.27.0] - 2026-07-23

### Added

- **`flair quality --emit` — quality OrgEvents (Slice 2 of the memory-quality-observability arc).** `flair quality` learns to snapshot, diff, and alert on regressions, riding the *existing* OrgEvent write surface — no schema change, no new table. Passing `--emit` (requires an agent identity) snapshots the report's numeric core, diffs it against the agent's previous quality snapshot (stored as a persistent-durability Flair memory, subject `quality-snapshot/<host>`), and publishes an OrgEvent (`quality.threshold_crossed` or `quality.regression`) for each finding via the same signed `PUT /OrgEvent/{id}` `flair orgevent` already uses (now shared through one `publishOrgEvent()` call site). Thresholds: embedding coverage below 90% or dropped >5pts, staleness above 10%, recall spot-check recall@k/MRR dropped >0.2, an agent newly quiet, dedup clusters grown >50% *and* by ≥5 — all edge-triggered (fires on the transition since the last snapshot, not on every run a condition merely persists) and all skipped on missing/gapped data (absence is never treated as a regression). Every event carries a behavioral fact, never a trust judgment ("embedding coverage dropped to 85% (threshold 90%)", never "agent X is low quality"). A first `--emit` run has no baseline to diff against, so it stores the snapshot and emits nothing. Without `--emit`, `flair quality` is unchanged — fully read-only, byte-identical output.

### Fixed

- **`flair upgrade` no longer kills itself mid-restart, leaving the server down (Linux / non-launchd macOS).** The port-based stop step ran a bare `lsof -ti :<port>`, which matches *any* process with a socket on the port — including the upgrading CLI's own keep-alive connections left open by the credential pre-flight's health probes. The CLI SIGTERM'd itself right after "Stopping…" and never reached "Starting…" (exit 143), so every default `flair upgrade` on the Linux path ended with the package upgraded but the server stopped. The stop now targets listening sockets only (`-sTCP:LISTEN`) and never signals its own PID. Forward-only (the restart runs on the *old* CLI): upgrading **from** ≤ 0.26.0, use `flair upgrade --no-verify`, or run `flair start` if you already hit it — see the known-issue note in `docs/upgrade.md`. Found by the Canary dogfooder on the 0.26.0 clean-box run; root-caused with a live socket-level repro.
- **Published package omitted `docs/` even though README links straight to it.** `README.md` points readers at `docs/mcp-clients.md`, `docs/integrations.md`, `docs/troubleshooting.md`, etc., but the root `package.json`'s `files` array never listed `docs/`, so every one of those links 404'd for anyone reading from the installed npm package rather than the git repo. Added `docs/` to `files` (704K total — well under the size where a media exclusion would be worth the complexity). Verified with `npm pack --dry-run` that the tarball now includes it (#801).
- **Non-interactive `flair init` silently skipped agent registration, MCP wiring, and the smoke test.** Running bare `flair init` (no `--agent`) in a non-TTY shell — CI, Docker, an unattended setup script — bootstrapped the Harper instance only and exited 0 with no indication anything was skipped; the gap was easy to miss until something that needed the agent (recall, an MCP client) mysteriously didn't work. Non-interactive runs now print an explicit notice ("Non-interactive shell: skipped agent registration, MCP client wiring, and the smoke test. Complete setup with: flair init --agent <id> --client all"). README's Quick Start also gained a note calling out that non-interactive environments must pass `--agent`/`--client` explicitly (#802).
- **`flair doctor`'s suggested `--fix` command failed when it had nothing to wire from.** Doctor printed `Fix: flair doctor --fix (wires <client> automatically)` for an unconfigured MCP client, but running that exact command failed with "no agent id known — pass --agent <id>" whenever no client was already wired (nothing to read an existing agent id from) and neither `--agent` nor `FLAIR_AGENT_ID` was set — the suggested fix didn't work as suggested. `--fix` now infers the agent id when exactly one is locally keyed (the only genuinely unambiguous case); zero or multiple keys still require an explicit `--agent` (told to register one, or to pick which id, respectively). The printed suggestion itself also now splices in a concrete `--agent <id>` when one is knowable, so copy-pasting it actually works instead of failing on the first try (#802).
- **`openclaw-flair`'s `autoCapture` never fired in long-lived persistent gateway sessions.** It only hooked `agent_end`, which fires at the true end of a discrete agent run — a persistent session's "run" never ends, so `agent_end` never fired and auto-capture was dead code in that deployment shape. Real-world: an agent ran May→July with the plugin registered on every boot and zero auto-captures, ever (#798). Auto-capture now also evaluates the same trigger regex live, per turn, on the `llm_input`/`llm_output` hooks (the user-facing prompt and the model's response) — these fire on every model call regardless of how the host bounds a "run", so persistent sessions capture in real time instead of waiting on an event that never comes. The existing `agent_end` path is unchanged for discrete runs. Both paths share one per-session cap (still 3 by default, now tunable via `autoCaptureMaxPerSession`) and dedup by content hash, so a phrase captured live isn't captured again when `agent_end` later rescans the same run's full history.

## [0.26.0] - 2026-07-22

### Added

- **`flair quality` — a read-only memory-quality report.** New command (`flair quality [--agent <id>] [--json]`) that answers "is my agent's memory healthy, or silting up with noise and stale entries?" It mirrors `flair status`/`doctor` — fetches `/HealthDetail` and computes CLI-side — reporting instance health, embedding coverage (% real vs hash-fallback), staleness (% expired), per-agent signal density (write volume + last-active, framed as a usage pattern), and quiet-agent detection. Read-only and downstream of all authority — it never influences access, ranking, or trust. Unavailable metrics degrade gracefully to a noted `gaps` entry rather than crashing. First slice of the memory-quality observability arc.
- **`flair quality`'s signal density now includes citation rate (Slice 1b).** `/HealthDetail`'s per-agent aggregation gained a server-side `usageCount` sum (one extra accumulation over memories already loaded there — no new query, no new endpoint), and `flair quality` computes `citationRate` from it (avg citations per memory, `usageCount / memoryCount`). Shown as a `citations` / `citation_rate` column per agent, `signalDensity.scope` flips from `write-volume` to `write-and-citation` once the server reports it. Talking to an older server that predates the aggregation degrades gracefully back to write-volume-only + a `gaps` note ("citation rate unavailable — server predates per-agent usageCount in /HealthDetail") rather than showing a false zero. Framed strictly as a usage pattern — a low citation rate means "writes exploratory content that's rarely cited," never "noisy" or "untrustworthy."
- **`flair quality` now reports a dedup-cluster count — how many near-duplicate memory clusters exist instance-wide (Slice 1c).** Unlike every other `quality` metric, this one is computed server-side, not CLI-side: embeddings are the most sensitive data in the system and must never leave the server. A new nightly REM step (`POST /MemoryDedupStats`, admin-gated) sweeps non-archived memories, runs a bounded-k nearest-neighbor query per memory against Harper's existing HNSW index, and groups near-duplicates (cosine ≥ 0.95) into connected components — a cluster of 5 memories counts as 1 cluster, not 10 pairs. Only the aggregate `{ clusterCount, largestClusterSize, totalMemoriesInClusters, computedAt }` is ever stored or exposed (no per-memory cluster membership, ever) — written to a small server-side stat file and surfaced through `/HealthDetail` for `flair quality` to read, the same cheap-read pattern every other metric here already uses. Shown in `flair quality` as "Dedup clusters (as of last REM run …)" — nightly-stale by construction, and framed strictly as an ops signal ("is memory silting up with duplicates"), never a trust judgment. Absent on a fresh instance or before the first nightly cycle: `null` + a `gaps` note, never a false zero.
- **`flair quality` now runs a recall spot-check — is semantic search actually working right now (Slice 1d)?** For a sample of the querying agent's own memories (10 by default, most-recently-written), each is searched for by a cue derived from itself (its `subject`, or the leading ~8 words of `content` if no subject) through the *exact same* authenticated read path `flair memory search` already uses — no new endpoint, no new auth mechanism. Reports `recall@5` (the fraction found in their own search's top 5) and MRR (mean reciprocal rank) as "Recall spot-check (agent <id>): recall@5 = 0.90, MRR = 0.82 over 10 sampled memories." This is a **health spot-check, not a benchmark**: querying by a cue derived from the memory itself is easier than a real user query, so a high score means recall is *functioning*, not that it's *optimal* — its job is catching recall cratering (embeddings down, index busted), not grading retrieval quality. No agent identity to query as, fewer than 10 memories to sample, or a search error all degrade to a `gaps` note rather than a misleading zero.

## [0.25.4] - 2026-07-22

### Fixed

- **`flair upgrade` couldn't detect a globally-installed flair when `flair` isn't on PATH.** For a custom npm prefix (mise/fnm/nvm/volta, or the sudo-less user-prefix install the README recommends), `flair upgrade` reported `not detected → run npm install -g` even though the package was installed, so the one-command upgrade never ran. The flair package probe now falls back to a `require.resolve`-based lookup — the same PATH-independent fallback `flair-mcp` already had. Found by the Canary dogfooder validating the 0.25.3 upgrade flow.

## [0.25.3] - 2026-07-22

### Fixed

- **README's quickstart used a command that doesn't exist.** The "Semantic Memory" example wrote memories with `flair memory write "..."` — but the CLI command is `flair memory add` (`write` was never a subcommand). Corrected to `flair memory add --agent <id> "..."` / `flair memory search --agent <id> "..."` (the actual, working forms). Every new user following the quickstart hit "unknown command 'write'" on their first write. Found by the Canary DevEx dogfooder on a clean-box run.
- **`flair` with no command now exits 0.** A bare `flair` prints help and exits 0 (it was exit 1 — a bare invocation is a help request, not a usage error). `-h`/`--help`/`-v` are unaffected.

## [0.25.2] - 2026-07-22

### Fixed

- `flair restart`/`flair upgrade` now invalidate the version-handshake cache on a successful restart, so `flair status`'s preAction nudge doesn't falsely report the pre-restart server version for up to 60s after an upgrade+restart.
- `flair upgrade` now primes the version-check cache with the latest version it just fetched fresh from the registry, so `flair status`/`doctor` immediately reflect it instead of a stale (up to 12h) cached value.
- n8n `FlairWrite` node's ephemeral-durability option label corrected from "auto-expires 72h" to "auto-expires 24h" to match the actual default TTL.

### Docs

- Fixed stale values found in a docs audit: `claude-code.md`'s ephemeral-durability TTL (72h → the actual 24h default), `system-requirements.md`'s embedding model (`Xenova/all-MiniLM-L6-v2`/384-dim/~85MB → the actual `nomic-embed-text-v1.5`/768-dim/~270MB), and `integrations.md`'s Codex/Gemini MCP config snippets (wrong file paths/formats → `~/.codex/config.toml` in TOML, `~/.gemini/settings.json`, matching `mcp-clients.md`). Also corrected `n8n.md`'s node count (two → the three actually shipped, adding Flair Write) and `mcp-clients.md`'s bridge tool count (seven → the eleven `flair-mcp` actually exposes). Added a known-issue note to `upgrade.md` documenting that the 0.25.1 post-restart-verify fix is forward-only: an upgrade *from* an older version is still verified by the old, unfixed CLI, so a credential-less verifier can report a false rollback on an instance that was healthy the whole time.

## [0.25.1] - 2026-07-21

### Docs — README refresh (trust-graded recall + accuracy fixes)

- Added a **Trust-Graded Recall** feature section documenting the 0.25.0 arc — the trust-evidence block, `matchQuality` confidence bands, first-class `abstain` verdict, and citation-on-write / `record_usage` — with an honest note on which surfaces expose it today (authenticated HTTP API + native `/mcp`) versus what's follow-up (`flair` CLI, `@tpsdev-ai/flair-client`, the `flair-mcp` bridge).
- Corrected the advertised MCP tool list (7 → the 11 the bridge actually exposes), the n8n node count (2 → 3, incl. Flair Write), moved the shipped first-run soul wizard out of "What's next", and reconciled the MCP client list.

### Fixed — `flair upgrade` no longer rolls back a healthy instance it just can't authenticate to

`flair upgrade`'s post-restart verification treated "the server responded but the verifier couldn't authenticate" (a 401/403 on the authenticated `/HealthDetail`) the same as "the upgrade broke the instance" — it triggered a rollback, whose own re-verify hit the identical missing-credential wall, leaving the operator with a false `ROLLBACK ALSO FAILED VERIFICATION — instance state is UNKNOWN` for an instance that was healthy the entire time. This bit a real `0.22.1 → 0.25.0` upgrade on a machine with no admin-pass/agent key: `/HealthDetail` became a *verified-read* (flair#747), so the verifier authenticated fine against the pre-upgrade version but not post-restart, and the pre-flight credential check can't anticipate a version that changes `/HealthDetail`'s auth requirement.

- A credentials-only failure (`isCredentialOnlyFailure`: healthy instance, authenticated-leg rejected with 401/403) on the post-restart verification now resolves to a new **`healthy-unverified`** outcome — the upgrade is reported **complete**, with a clear note that the version couldn't be verified and how to enable full verification (`FLAIR_ADMIN_PASS` / `flair init`). It **never rolls back**: the public `/Health` already proved the server is up, and a version we can't *read* is not grounds to roll back a *running* instance. This supersedes flair#741 fix #3's "prefer the known-good version" default, which the incident proved wrong for a healthy instance.
- Scoped strictly to credentials: a genuine server-side failure (unhealthy `/Health`, a 5xx, or a network error on the authenticated leg) still rolls back exactly as before.

## [0.25.0] - 2026-07-21

### Trust-graded recall — citation-on-write (flair#744 slice A)

Memory usage feedback (`record_usage`, flair#683) required a separate call after the fact. Now a write can cite the memories that informed it inline: an optional `usedMemoryIds?: string[]` on the memory write surfaces (`Memory.post`/`Memory.put`, the `memory_store` MCP tool, `flair-client.mjs write --used <csv>`) credits each cited memory through the exact SAME deduped, principal-bound usage ledger `record_usage` writes to — no separate call, no duplicated ledger logic (`resources/usage-recording.ts` extracts the shared ledger-write core so RecordUsage and citation-on-write share one implementation).

- **Post-commit, non-blocking.** Citation recording runs strictly AFTER the memory write commits. A recording failure is logged server-side and swallowed — it never changes the write's response, never rolls back or retries the write.
- **Silent drop for anything outside read scope.** Reusing `record_usage`'s existing ledger path means a cited id that doesn't exist (or isn't visible to the writer) is a quiet no-op, exactly like `record_usage` — no error, no observable difference between "not found" and "already credited".
- **agentId always from the resolved auth context.** The ledger key is `{writerAgentId}:{citedMemoryId}`, where `writerAgentId` comes from the same auth resolution `Memory.post`/`put` already perform — never from the request body. A caller cannot credit a contribution on behalf of another identity.
- **Opt-in, additive, clean migration.** `usedMemoryIds` is consumed-and-stripped from the write body before the row is persisted (same discipline as `claimedClient`) — it is never stored on the Memory record itself. Omitted entirely ⇒ zero new calls, byte-identical to before.
- **Trust-block absent-vs-0 fix.** The trust block's `usageCount` field is now `number | null`: `null` when no usage has ever been recorded, a real `0`/`3`/etc. when it has — so a reader can tell "no usage signal yet" apart from "recorded, zero uses" instead of both reading as a false `0`.
- New pure unit coverage in `test/unit/usage-recording.test.ts` (auth gating, cap/dedup, per-id failure isolation, agentId provenance) and `test/unit/trust-block.test.ts` (the absent-vs-0 cases); new integration coverage in `test/integration/citation-on-write-e2e.test.ts` (ledger-sharing dedup parity with `record_usage`, cross-agent isolation, out-of-scope/nonexistent-id silent drop, post-commit write-success isolation).
- Consumer wiring (openclaw-flair / flair-mcp actually passing `usedMemoryIds` on real writes) is a follow-up slice, out of scope here.

### Trust-graded recall — `matchQuality` confidence bands on the trust block ("breadcrumbs, labeled") (flair#744)

Recall shouldn't be binary confident-match / nothing. A weak, fuzzy match is *valuable* if the agent knows it's weak — a breadcrumb taken for what it is. The hallucination risk isn't returning weak matches; it's returning them **undifferentiated** from strong ones. Abstention (slice 2) already returns breadcrumbs (it only abstains at a near-zero floor); this adds the **label** that says "this is a breadcrumb, not a fact." Each recall result's trust block now carries a **`matchQuality: "strong" | "moderate" | "breadcrumb" | null`** field, derived purely from the result's absolute semantic similarity.

- **The three bands, from absolute cosine similarity (`_semSimilarity`, the same signal abstention uses — NOT the RRF-normalized rank score).** `strong` (sim ≥ 0.55), `moderate` (0.35 ≤ sim < 0.55), `breadcrumb` (below 0.35, down to and including anything present below the abstention floor — the weakest present band, no 4th band). **`null`** when there is no similarity signal to judge — a keyword-only degraded search, or a by-id `get` (no retrieval pool): an honest "we couldn't classify this one", never a false label.
- **Single source of truth (Kern BINDING condition 1).** The `breadcrumb` floor **is** the shared `ABSTENTION_THRESHOLD` constant (imported, never a duplicate `0.15` literal) — the bottom of the breadcrumb band is exactly the top of abstention, so if recall-bench moves the abstention floor the band moves with it. The two new band cut-points (`MODERATE_BAND = 0.35`, `STRONG_BAND = 0.55`) are global constants in the same module (`resources/abstention.ts`) as `ABSTENTION_THRESHOLD` — one module, one source of truth. They are **conservative hand-set placeholders**; recall-bench calibration of the cut-points is a **separate follow-up** (same posture as `ABSTENTION_THRESHOLD`).
- **Opt-in, off = byte-identical.** `matchQuality` is a trust-block field — it appears iff the block does (`includeTrust`). Because the classifier needs `_semSimilarity` on the result, `includeTrust` now also turns on `withSemSimilarity` internally on the retrieval call (Kern BINDING condition 2, previously gated on `abstain` alone); the internal field is stripped from consumer-facing `search` results exactly as slice 2 already did. With neither `includeTrust` nor `abstain`, recall is byte-identical to before (no `_semSimilarity`, no block).
- **Global, never per-principal (Sherlock spine).** The classifier (`resources/trust-block.ts`'s `classifyMatchQuality`) is pure: its only input is the one similarity number — no agentId/principal/tier. A per-principal band would be an authority lever, a hard no. The existing no-per-principal tripwire (`test/unit/abstention-no-per-principal-tripwire.test.ts`) is extended to cover the classifier body AND the band-boundary constants (per Sherlock's note): it fails the build if the classifier ever references an authority signal, if the breadcrumb floor stops referencing the shared `ABSTENTION_THRESHOLD` constant, or if a wrapper stops enabling `withSemSimilarity` when `includeTrust` is requested. `matchQuality` never enters an access/scope/attribution/dedup decision.
- New pure unit coverage in `test/unit/trust-block.test.ts` (each band at representative similarities and the exact `>=`/`<` boundary values; `null` when no signal; the breadcrumb floor tracks the shared constant; the raw similarity is never surfaced, only its band; `attachTrust` propagates it).
- Recall-bench calibration of the band cut-points is a separate follow-up. See flair#744.

### Trust-graded recall — first-class abstention verdict ("no memory covers this") (flair#744 slice 2)

Weak matches presented as answers are how a memory system *causes* confabulation instead of preventing it. When the best retrieval match is below a confidence floor, recall can now return a first-class **abstention verdict** — "no memory covers this" — instead of the N weakest matches. This ships the abstention *response shape*, deliberately **decoupled from threshold calibration** (the design round's sharpening): consumers build against the API now; tuning the floor on the recall-bench corpus and promoting abstention to the default recall mode is a **separate follow-up** (see flair#744).

- **Opt-in, additive, clean migration.** Off by default (`abstain`): a recall that doesn't request it is byte-identical to before — no abstention fields, and the absolute-confidence signal the decision needs is attached to retrieval results only when requested. `search` (SemanticSearch): `abstain: true` ⇒ below the floor returns `{ abstained: true, reason, bestScore, threshold, results: [] }` (no weak matches, and no rerank/hit-tracking for memories it declines to surface); above the floor returns normal results plus a stable `{ abstained: false, bestScore, threshold }`. `bootstrap` (BootstrapMemories): `abstain: true` adds an `abstention` object reporting whether any memory covered `currentTask` — scoped to the task-relevance surface (identity/permanent/recent are always returned), and never removing a memory the reader would otherwise have seen (its floor sits below bootstrap's own long-standing task-relevance floor). Requestable over the native `/mcp` tools (`memory_search`, `bootstrap`).
- **Confidence signal = absolute cosine, not the ranking score.** The decision reads the best-match absolute semantic similarity (`_semSimilarity`, cosine in [0,1]), NOT the ranking `_score`: the hybrid path RRF-normalizes `_score` so the top result is always ~1.0 regardless of how weak the real match is, which is unusable as a confidence floor. When there is no embedding-based match to judge at all (e.g. a keyword-only degraded search), abstention stays conservative and returns what was found rather than a confident "nothing covers this".
- **GLOBAL threshold — NEVER per-principal (Sherlock BINDING condition 2, #735-spirit).** A per-principal threshold ("this principal's memories need higher confidence to surface") would be an authority lever and is a hard no. The threshold is a single global constant (`ABSTENTION_THRESHOLD = 0.15`, conservative — below the score band real embeddings produce for genuinely relevant memories), and the decision (`resources/abstention.ts`) is pure and consults ONLY a confidence number — no agentId/principal/tier anywhere. A new structural tripwire (`test/unit/abstention-no-per-principal-tripwire.test.ts`) fails the build if the abstention module or any call site's argument ever references an authority signal, and pins the decision function's arity to its single numeric input (no threshold parameter to vary per call/per principal).
- New pure unit coverage in `test/unit/abstention.test.ts` (below-threshold ⇒ verdict; at/above ⇒ normal results; null ⇒ never abstain; best-confidence selection ignores non-similarity fields; identical confidence ⇒ identical verdict regardless of candidate authorship).
- Slice 3 (corroboration count, nightly on the REM runner) is separate and pending; threshold calibration to promote abstention to the default recall mode is its own recall-bench follow-up. See flair#744.

### Trust-graded recall — opt-in, inline trust-evidence block on recall results (flair#744 slice 1)

The memory layer already records per-fact trust evidence at write time; this surfaces it at read time, where the consuming agent decides what to repeat. `search` (SemanticSearch), `get` (Memory.get), and `bootstrap` (BootstrapMemories) can now attach a compact, self-contained `trust` block per result — assembled ENTIRELY from fields the recall path already resolved, with no new computation, no cross-record lookups, and no hot-path cost.

- **Opt-in, additive, clean migration.** Off by default (`includeTrust`): a recall that doesn't request the block is byte-identical to before — the trust field is never added, and the retrieval projection is only widened (with `provenance`) when the block is requested. `search`/`get` attach the block inline on each result object; `bootstrap` (which renders memories as text) returns a `trust` array with one self-contained entry per included memory. Requestable over the native `/mcp` tools (`memory_search`, `memory_get`, `bootstrap`).
- **Block contents (from each Memory record's own stored fields):** author principal (`agentId`, always included); provenance status (verified vs claimed — `verified.agentId`/`verified.timestamp`, plus a BOOLEAN `hasClaimedProvenance`; raw `claimed.*` content is never surfaced as authoritative); usage signal (`usageCount`); freshness/validity (`validFrom`/`validTo` → valid/expired/future, plus `createdAt` age in days); supersession forward-pointer (`supersedes`).
- **Trust `tier` is DEFERRED to a later slice (Sherlock condition 1).** A tier is not on the Memory record — it lives on the author's principal (`defaultTrustTier`), so surfacing it needs a per-author lookup on the hot recall path AND the mandated scope-gate ("include tier only when reader.scope == author.scope"), which needs an org/scope boundary primitive flair's single-tenant "open-within-org" model doesn't yet have. Both are more than trivial for slice 1, so the tier field (and its scope-gate) ship together in a later slice; everything else in the block ships now.
- **Zero-authority invariant (Sherlock condition 2, #735-spirit).** The block informs the reader only — it is assembled strictly downstream of read-scope resolution, in each recall wrapper's response tail, and never re-enters an authority/scope/attribution/dedup/usage-count/ranking decision. `buildTrustBlock` is pure (never mutates the record). A new structural tripwire (`test/unit/trust-block-zero-authority-tripwire.test.ts`) fails the build if any authority/core module (read-scope, attribution, dedup gates, usage-count writer, MCP auth, retrieval core) ever references the trust-block assembler.
- New pure unit coverage in `test/unit/trust-block.test.ts` (each field maps to its stored value; verified/claimed/legacy/malformed provenance; validity valid/expired/future; tier absent; purity; opt-in off ⇒ same reference / on ⇒ additive block).
- Slice 2 (explicit abstention) and slice 3 (corroboration count, nightly on the REM runner) are separate and pending — see flair#744.

### ⬆️ @harperfast/harper 5.1.17 → 5.1.22 — dependency currency + upstream fixes

@harperfast/harper 5.1.17 → 5.1.22 (dependency currency; pulls upstream config-validator + platform fixes). Exact-pin bump within the same minor — dependency + lockfile only, no flair code change. Resolved tree confirmed at 5.1.22. The full unit suite, the process-isolated module-mocking files, and the Harper-touching auth / resource / schema / mcp suites all pass green; the `test/integration/` Harper-runtime suite is the authoritative gate for a runtime-dependency bump and runs in CI. The transitive `harper` peer pulled in by @harperfast/oauth is unchanged (pre-existing, tracked in flair#750).

## [0.24.0] - 2026-07-21

### Harden TPS-Ed25519 auth-header parsing — bound length + disjoint capture classes for linear-time parsing

Robustness hardening for the `Authorization: TPS-Ed25519 …` header parser shared by the three auth call sites (`auth-middleware.ts`, `agent-auth.ts`, `Presence.ts`). The header is untrusted client input; the parser is now bounded and always linear-time.

- **Disjoint capture classes.** The two colon-delimited text captures now use `[^:\s]+` instead of `[^:]+`, so they no longer overlap the preceding `\s+`. With no character shared between adjacent quantifiers there is a single unambiguous split, keeping the match strictly linear on any input. Behavior-preserving for well-formed headers — a real agentId / nonce / signature never contains whitespace.
- **Length bound before the regex.** Inputs longer than `MAX_AUTH_HEADER_LEN` (4096; a valid header is a few hundred chars) are rejected up front and treated exactly like a non-matching header (no valid agent auth).
- **Single shared parser.** Extracted `parseTpsEd25519Header` + the grammar/bound constants into `resources/ed25519-auth.ts` (already the shared home for the nonce store and key import), replacing three in-line copies of the regex so the grammar and its bounds can't drift.
- New tests in `test/unit/ed25519-auth.test.ts`: a valid header parses correctly, a long degenerate input parses in linear time (well under bound), over-length headers are rejected, and a header sized exactly at the bound still parses.

### 🔒 Ops-API domain-socket permission posture — 0600 default / 0660+group opt-in with a directory gate (flair#763)

Split from flair#670 (the network-bind slice shipped in #762); same local-admin-surface axis as #654 (`authorizeLocal` off). Ground-truthing a live macOS install reshaped the original "socket is 0666" framing: Harper sets no mode, so the socket lands at `0777 & ~umask` (0755 here) — real, but umask-luck — and `~/.flair` was already `0700`, making the *directory* the effective gate by accident. Harper exposes no socket-permission knob (`operationsApi.network.domainSocket` is a path string only; no `chmod` in `dist/server`), so flair sets the posture itself around the socket the start path creates.

- **Primary gate = the socket's immediate parent directory, made policy.** Resolved from the configured socket path — never a hardcoded `~/.flair`, so a custom `--data-dir` install is gated at its own root. The directory gate is the load-bearing control: race-free (checked on every `connect(2)` traversal — no create→chmod window), umask-independent (explicit `chmod`), and cross-platform (VFS-level, unlike socket-file permission enforcement on `connect(2)` which varies across BSD lineage). The socket file mode is defense-in-depth within it.
- **Posture, kept in lockstep both directions:**
  - `FLAIR_SOCKET_GROUP` unset → parent dir `0700`, socket `0600` (owner-only — the 99% single-user case; strictly tighter than `0660`+`staff`, which on macOS is shared by every human account on the box).
  - `FLAIR_SOCKET_GROUP` set → parent dir `0750` (owner+group traverse — else the group grant is unreachable behind the dir gate), socket `0660` + `chgrp` to that group.
  - A later **unset returns** the dir to `0700` and the socket to `0600` — the two layers widen and tighten together.
- **Fail-closed group handling.** The group name is regex-validated (`^[a-zA-Z_][a-zA-Z0-9._-]*$`) **before** existence resolution; an invalid **or** missing group is a hard error — never a silent fallback to `0600`. A `chgrp` that fails because the user isn't a member gives a clear "requires membership" message (distinct from "does not exist"), and a broad system group (`staff`/`wheel`/`users`/`admin`/…) emits a warning (not a block).
- **Applied in `init` and every start readiness path.** `init` puts the directory gate in place **before** Harper spawns (closing the create→chmod window) and applies the socket mode once the socket appears; `flair start` and the internal restart/upgrade start path re-assert the posture on the freshly-created socket. The default-posture path is non-fatal defense-in-depth (warn — the dir gate is the primary control); a broken `FLAIR_SOCKET_GROUP` opt-in fails loud.
- **`flair doctor` finding (report-only, no `--fix`).** Re-tightening a live socket needs a restart, so the remedy is `flair init`/restart, not an auto-fix. Implements the exact six-row detection matrix: dir `0700`+socket `0600` → clean; dir `0755`+socket `0600` → flag (root gate breached); dir `0700`+socket `0755` → flag (socket mode breached); both open → flag; dir `0750`+socket `0660` with `FLAIR_SOCKET_GROUP` set → clean (deliberate multi-user); dir `0750`+socket `0660` without the opt-in → flag (unintended group access).
- New `test/unit/ops-socket-posture.test.ts`: the posture helper in both postures, lockstep both directions, group-name validation (valid/invalid/missing + not-a-member + broad-group), and all six doctor matrix rows — in-memory fs and mocked group resolution, no real socket or `~/.flair` touched.

Closes #763. References #670 (parent — network bind shipped in #762) and #654 (lineage — same local-admin-surface axis).

### 🔒 Bind the Harper ops API to loopback + domain socket for single-host installs (flair#670)

Defense-in-depth follow-up to flair#654 (K&S concurrence 2026-07-09): #654 closed the unauthenticated-loopback-admin hole by disabling `authorizeLocal`; this shrinks the *network* surface. The ops API (`:9925`-equivalent) bound all interfaces unconditionally — single-host installs don't need remote admin, so an accidentally-exposed port (misconfigured firewall, container networking) could be reached off-box even with #654's auth fix in place.

- **`flair init`'s single-host default**: the ops API now binds `127.0.0.1` (loopback) + the domain socket (`flair init` already provisioned `operationsApi.domainSocket`; it's now correctly nested at `operationsApi.network.domainSocket` — Harper's own config schema path (`@harperfast/harper/config-root.schema.json` → `properties.operationsApi.properties.network.properties.domainSocket`, confirmed against `dist/validation/configValidator.js`'s Joi schema) — instead of a sibling of `network`, where Harper's config validator never reads it). The bind mechanism: Harper's config accepts `operationsApi.network.port` as either a bare number (all interfaces — the old behavior) or a `"host:port"` string, which its server bootstrap (`dist/server/threads/threadServer.js`, `listenOnPorts`/`listenOnPortsBun`) splits into an explicit bind host. `flair init` now always writes the `"host:port"` form.
- **Escape hatch (required for multi-host/Fabric)**: `--ops-bind <addr>` flag or `FLAIR_OPS_BIND` env var overrides the loopback default with any address (e.g. `--ops-bind 0.0.0.0` for deployments that genuinely need remote ops access). Default stays loopback-only.
- **Scoped to `init`, not a silent rebind**: only `flair init` writes this. An existing all-interfaces install keeps its current binding until re-`init`'d — re-running `init` on a running instance updates the persisted config/launchd plist for the *next* restart, but never live-rebinds a socket that's already listening. `flair start`'s non-launchd fallback spawn (Linux, or macOS without a plist) re-resolves the same loopback-default/`FLAIR_OPS_BIND` host on every start instead of a bare port number, so a plain restart can't silently strip the bind back to all-interfaces via `OPERATIONSAPI_NETWORK_PORT`'s env-var precedence over the persisted config file.
- **`flair doctor` finding (report-only, no `--fix`)**: flags a persisted all-interfaces bind (bare port, no host prefix) in `harper-config.yaml` and points at `flair init` as the remedy — rebinding requires a restart, so `doctor` never touches it automatically. An explicit `0.0.0.0:<port>` (the deliberate escape hatch) is not flagged — it's a documented opt-in, not an accident.
- New `test/unit/ops-api-bind.test.ts`: `resolveOpsBindHost` flag/env/default precedence, `buildOperationsApiConfig`'s exact JSON shape (loopback default, escape-hatch verbatim, nested domain socket, idempotent re-init), and `detectOpsApiAllInterfacesBind`'s doctor-finding decision logic (bare-port vs host-prefixed vs deliberate `0.0.0.0`).

Closes #670. References #654 (lineage — the authorizeLocal fix this follows up on).

### ⬆️ @harperfast/oauth 2.2.0 → 2.4.0 — inherits the callback session-binding + DCR-default-disabled security fixes

Bumps the exact pin two minors. 2.3.0 added the backward-compatible `onLogin` outcome hook (plain/undefined returns unchanged — flair uses none). 2.4.0 ships two security fixes flair benefits from directly: **OAuth callbacks are now bound to the initiating browser session** (#181/#183 — rejects a state token minted in a different session, the RFC 6749 §10.12 login-CSRF class), and **MCP DCR now defaults to disabled when the `dynamicClientRegistration` block is absent** (#182/#184 — the pre-2.4.0 default was open, ungated registration). The latter makes flair#757's explicit `dynamicClientRegistration: { enabled: false }` belt-and-suspenders rather than load-bearing, and closes the exposure for any flair instance that enabled the OAuth surface without writing the block. flair's CIMD-only config surface (`clientIdMetadataDocuments.allowedHosts`) is unchanged and verified against 2.4.0 — the mcp-enable/handler/grant suites and the full unit suite pass green. Dependency + lockfile only, no flair code change.

### 🐛 Instance-scoped launchd label — a second instance no longer silently replaces the first (flair#693)

Found the hard way during CI-lane validation on a shared host: `flair init`/`start`/`stop` registered their macOS launchd service under the hardcoded label `ai.tpsdev.flair`, independent of HOME or data dir. A second Flair instance on the same host — a dev checkout next to prod, a second user, the Harper-app embedded-component shape — collided with and could unload/replace the production daemon.

- **The label now incorporates instance identity**: `ai.tpsdev.flair.<8-hex-char sha256 of the resolved data dir>`. Different data dirs always produce different labels (no collision); the SAME data dir always produces the SAME label across runs (idempotent `init`/`start`/`stop` — re-running any of them still targets the same service). For the default single-instance install (`~/.flair/data`) this is a fixed value per machine/user. One shared helper (`launchdLabel`/`resolveLaunchdLabel` in `src/cli.ts`) computes it everywhere — no more scattered `"ai.tpsdev.flair"` string literals across the plist-generation, load/unload/start/stop, and uninstall code paths.
- **Migration for existing installs (no orphaned daemons)**: an install currently running under the old bare `ai.tpsdev.flair` label is detected automatically — `start`/`stop`/`uninstall` find and manage it if the new-labeled service isn't present, preferring the new label when both would resolve. `flair init` (which always has fresh plist content in hand) cleanly unloads and removes the legacy registration before writing the new one. `flair start` (and the internal `startFlairProcess` used by `restart`/`upgrade`/snapshot flows) actively transitions a legacy install: unload the legacy service, rewrite its plist under the new label, remove the legacy plist file, THEN load and start under the new label — that order is load-bearing (never a moment with both registered) and pinned by a dedicated test. `flair uninstall` sweeps both the new and legacy plist paths so a stray leftover from a partial migration can't survive a purge. **No user is left with two daemons; no re-init is required to pick up the fix — a plain `flair start` on an existing install migrates it.**
- New `test/unit/launchd-label.test.ts`: different data dirs → different labels; same data dir → identical label across invocations; the default install's label format; legacy-only/new-only/both-present detection; the full migrate-then-load-then-start call order via a mocked `launchctl` runner (never the real launchd or `~/Library/LaunchAgents` — a temp dir stands in); and a structural check that no bare `"ai.tpsdev.flair"` literal remains in cli.ts outside the one constant declaration.

Closes #693.

### 🐛 Deterministic deploy child-process output capture — kills the #699 CI flake

`deploy.test.ts`'s "--deploy-retries 0 disables retry" (and the rest of the replication-flake suite) intermittently failed under loaded CI runners with the generic `"harper deploy exited with code 1"` instead of the parsed `/peer replication failed after 1 attempt/` signature — a real output-capture race in production code, not a test-only artifact.

- **Root cause** (`src/deploy.ts`'s `spawnHarperCaptured`): the promise resolved on the child process's `"exit"` event, which Node's own docs warn can fire while the piped stdout/stderr streams are still delivering buffered `data` events. Under scheduler pressure, `exit` could win the race against the final stderr chunk — often exactly the line carrying the replication-failure signature, since it's written immediately before `process.exit()` — so `REPLICATION_FAILURE_RE` silently missed a match it should have made, and `runHarperDeploy` fell through to the generic exit-code error. This affects real `harper deploy` invocations too, not just the test's scripted fake binary.
- **Fix**: resolve on `"close"` instead — the event Node guarantees fires only after all stdio streams have ended, i.e. every `data` chunk has already been delivered to the listeners before the promise resolves. No retry, no sleep, no skip — the deploy code now waits on the correct completion signal.
- **Verify**: `deploy.test.ts`'s "disables retry" test looped 50x clean (0 failures), then 50x again under genuine concurrent load (8 CPU-bound hogs at ~97% each on a 10-core box, plus 6-way concurrent `bun test` invocations racing for CPU/pipe I/O) — 0 failures. Full `deploy.test.ts` looped 30x in isolation — 0 failures. Full `test/unit/` suite green (2614 pass). The exact race window is narrow enough that it could not be forced locally even under heavy synthetic load or a standalone spawn-concurrency probe (consistent with the issue's own report that all 37 deploy tests passed locally and it only manifested on loaded CI runners) — the fix is a structural guarantee from Node's documented `close`-vs-`exit` API contract, not a probabilistic mitigation.

Closes #699.

### ✨ Ed25519 agent key as the universal CLI auth floor (flair#747)

Generalizes flair#741/#742's upgrade-only agent-key fallback into ONE shared resolver adopted across every auth-requiring CLI surface. Before this, CLI auth resolved through per-command admin-pass chains that mostly ignored `~/.flair/keys/<agentId>.key` — the credential a headless/agent machine actually has — unless an agentId was already known some other way. That mismatch is exactly what produced flair#741's false "instance state UNKNOWN" terror on `flair upgrade`; this closes the same gap everywhere else it existed.

- **New `src/lib/auth-resolve.ts`** — the single resolver (`authedRequest`), with a documented 5-tier order: explicit flag (`--admin-pass`-equivalent, or `--key`+agent) → env (`FLAIR_TOKEN`/`FLAIR_ADMIN_PASS`/`HDB_ADMIN_PASSWORD`) → a pinned agent identity's own key (`--agent`/`FLAIR_AGENT_ID`/an id already in the request body or query string) → the secure `~/.flair/admin-pass` file (local targets only) → **the floor**: sign the same request with every registered key under `~/.flair/keys` (sorted, first-to-authenticate wins), engaged only when NOTHING above resolved to anything sendable at all (never on a rejected credential — that stays a distinct, more specific error). This is the natural first extraction from the cli.ts monolith (flair#622).
- **Consolidated, not wrapped**: `api()` (backing memory search/list, relationship add, soul/workspace/presence writes, orgevent, and most other authenticated commands) now delegates its ENTIRE auth resolution to `authedRequest` instead of an inlined ~30-line chain — every one of those commands inherits the floor for free. `verifyAuthedGet` (flair#741/#742's upgrade verification) collapses to a one-line call into `api()`, since the floor now lives there natively. `flair status`'s `fetchHealthDetail` (backing `status`, `status rem/federation/auth/bridges/deep`) replaces its own bespoke agent-key-first/admin-env-only chain — which had NO admin-pass-file leg and NO floor at all when `--agent` wasn't given — with one call, gaining both. `flair bootstrap` replaces its Ed25519-only (no admin fallback whatsoever) header-building with the same call, so a bootstrap machine can now also ride admin-pass, not just its own agent's key.
- **`flair doctor`'s verified reads** (fleet presence, migration state) were already agent-key-native by design and needed no behavior change — they get the primitive relocation (`buildEd25519Auth`/`resolveKeyPath`/`authFetch`, now defined once in the new module) for free via the same import.
- **Deliberately NOT touched**: write/admin surfaces (`agent`/`principal`/`idp`/`mcp grant`/`revoke`, `backup`/`restore`, `memory hygiene`, federation pairing, `keys prune`, etc.) keep their explicit `--admin-pass`-required gates — per the issue's own carve-out, a single agent's Ed25519 key is a scoped, read-appropriate identity, not a substitute for admin material on operations that mutate other agents' data or cluster config.
- **Every existing explicit-flag/env precedent preserved bit-for-bit**: a pinned `FLAIR_AGENT_ID`+key still wins over the admin-pass file (flair#634); an explicit env/flag still wins over everything (regression-locked by the existing `test/unit/local-no-auth.test.ts` and `test/unit/upgrade-verify-preflight.test.ts` suites, both green unchanged).

New `test/unit/cli-auth-floor.test.ts`: `authedRequest`'s full tier order (including the floor generalized to a non-GET method, and the "rejected credential never engages the floor" guard), end-to-end subprocess coverage of `flair status`/`flair bootstrap` against a mock server on an agent-key-only machine, an admin-pass-only machine, and a no-material-at-all machine (asserting the honest error, never a stack trace or a false "down" report), and a structural suite asserting `api()`/`verifyAuthedGet()`/`fetchHealthDetail()`/`bootstrap` each delegate to the one shared resolver with no residual inlined admin-pass-only chain of their own.

Closes #747.

### 🐛 `Memory.put`/`post` treat explicit `supersedes: null` as absent, not malformed (flair#704)

Found seeding real-shaped rows via the ops API: `Memory.put()` 400'd ("supersedes must be a string") whenever `supersedes` was present with an explicit `null`, while omitting the key entirely worked fine. Every JSON writer that serializes an unset optional field as `null` (`{supersedes: x ?? null}` is the common shape — most writers do this, `JSON.stringify` only drops `undefined`) hit this — in the field case, every embedding-regen call failed until the key was stripped by hand.

- **Fix**: `validateAndAuthorizeSupersedes` (`resources/Memory.ts`) now deletes the key when `content.supersedes === null` before the type check, per the additive-schema convention (flair#695: an explicit null on an optional/nullable field reads as absent, not as a distinct value). Because Harper's `put()`/`post()` are full-record replacement (see `table-helpers.ts`), deleting the key means the stored row genuinely has no `supersedes` field — never a literal `null` — byte-for-byte identical to the omitted-key case. Every downstream `if (content.supersedes)` / `if (!content.supersedes)` check (dedup-gate branch, `closeSupersededIfNeeded`, `validFrom` default) already treats "absent" correctly, so no other code changed. A genuinely malformed value (non-string, non-null) is still rejected with 400 — the leniency is null-specific.
- **Scope, audited field-by-field**: `supersedes` was the only optional string field on `Memory` with hostile explicit-null validation. `visibility`/`durability`/`archived`/`validFrom`/`expiresAt`/`archivedAt`/`promotedAt`/`entities` already treat null and absent identically (existing `?? `/`||=`/`=== undefined || === null` patterns); `originatorInstanceId` already uses a loose `== null` check. `parentId`, `sessionId`, `promotedBy`, `tags`, `source`, `subject`, `summary`, `contentHash`, `embeddingModel`, `promotionStatus`, `archivedBy`, `derivedFrom`, `lastReflected` have no explicit validation at all — never 400 on null, nothing to fix. `validTo` is deliberately excluded: its schema comment documents null as a MEANINGFUL sentinel ("still valid"), not an absence — collapsing it into "absent" would be a real behavior change, not a leniency fix.
- Tests (`test/unit-isolated/memory-integrity.test.ts`): `supersedes: null` succeeds on both `post()` and `put()` with the stored row missing the key entirely (verified via `"supersedes" in row`, plus a full key-set comparison against the omitted-key case); an existing record's `supersedes` can now be cleared via an explicit-null merge-and-PUT; a valid string value is unaffected; a non-string/non-null value still 400s on both `post()` and `put()`.

Closes #704.

### 🐛 `flair mcp enable` goes CIMD-only — DCR removed entirely, not just from the default flow (flair#756)

Corrects flair#754's default before any real-world `enable` run against a live instance. #754 shipped `enable` pre-registering claude.ai via DCR (RFC 7591) and provisioning a DCR gate token as part of its DEFAULT flow. That contradicted the strategic direction (Nathan, on the record, same-day): CIMD-only looking forward, DCR is not the path. The fix was scoped twice in one day — first to "CIMD-first with a `--with-dcr` legacy hatch," then amended to full removal: DCR is UNSUPPORTED on this surface, not legacy, and there is no flag to bring it back.

- **`flair mcp enable`'s default (and only) flow**: no DCR pre-registration, no gate-token generation, anywhere. Instead it writes `clientIdMetadataDocuments.allowedHosts: [claude.ai, claude.com]` alongside the existing `@harperfast/oauth` config block. The post-enable summary reflects CIMD (a URL to paste into claude.ai's connector settings — no client ID, since Claude presents its own CIMD document URL as its client_id).
- **Ground-truth fix, load-bearing**: leaving `dynamicClientRegistration` unset does NOT disable DCR — the installed `@harperfast/oauth@2.2.0` defaults it to ENABLED with OPEN (ungated) registration (`dist/types.d.ts:131-144`, `dist/lib/mcp/dcr.js:161-167,16-24`). `enable` now writes `dynamicClientRegistration: { enabled: false }` EXPLICITLY — the one config shape that actually 404s `/oauth/mcp/register` — and never writes `initialAccessToken`/`allowedRedirectUriHosts`. A structural test (`test/unit/mcp-enable.test.ts`) asserts the config block always carries this exact shape.
- **`src/lib/dcr-client.ts` is deleted** — the DCR gate-token contract and RFC 7591 HTTP client it owned have no remaining consumer.
- **`flair mcp grant`/`revoke`'s workflow gate** no longer requires the DCR gate token's local presence as proof `flair mcp enable` ran (a CIMD-only instance legitimately has no such token). Replaced with a live probe of the target instance's OAuth metadata endpoint, reusing `enable`'s own `selfVerifyMcpMetadata` — the same check `enable` and `flair mcp status` use, so all four commands agree on what "enabled" means.
- **Self-verify extended**: `selfVerifyMcpMetadata` now also confirms the metadata endpoint advertises CIMD support (`client_id_metadata_document_supported: true` AND `"none"` present in `token_endpoint_auth_methods_supported` — the exact pair Anthropic's docs say Claude's client checks before using CIMD instead of DCR). `flair mcp status` surfaces this as a `CIMD: advertised/not advertised` line.
- **Docs**: `docs/notes/mcp-oauth-model2.md`'s config example is CIMD-only; DCR moves to a one-line "Legacy clients" note ("DCR is not supported; clients connect via CIMD").

Closes #756.

### ✨ `flair mcp enable/disable/status` — one-command hosted-shape Claude-connector enablement (flair#719)

The final piece of the paved-paths command family: automates docs/notes/mcp-oauth-model2.md's 8-step operator checklist (RS256 keypair + DCR gate token, `@harperfast/oauth` config block, IdP OAuth-app credential intake, shape-aware secrets provisioning, identity mapping, claude.ai pre-registration, flag + restart, self-verification) into one command.

- **Binding scenario addendum, honored exactly**: `enable` targets the HOSTED shape only. It runs on the OPERATOR's machine, against a REMOTE instance (`--instance <url>`, else `FLAIR_URL`) — never against localhost. A local-origin instance is refused immediately with the exact addendum message ("claude.ai connectors need a public HTTPS origin; this instance is local. See the hosted-shape docs.") instead of walking eight steps toward a connector that can never connect. Local/private detection covers `localhost`, loopback, RFC1918 ranges, link-local, and `.local` mDNS.
- **Real dependency-driven execution order, named explicitly**: the design's numbered checklist is conceptual — DCR pre-registration and self-verification are both LIVE calls against the OAuth surface, which only exists once the instance has restarted with `FLAIR_MCP_OAUTH=1` live. `enable` applies config + restarts BEFORE pre-registering claude.ai (not after, as the checklist's raw numbering would suggest), documented in `src/lib/mcp-enable.ts`'s module header rather than silently reordered.
- **Ground-truth "existing remote ops paths"**: verified against the installed `@harperfast/harper@5.1.17` source (not assumed) that the Operations API has genuine `set_configuration` (writes harperdb-config.yaml) and `restart` (whole-process restart) operations — called the same admin-Basic-auth way `flair mcp grant/revoke` already call the ops API, local port or remote URL. `FLAIR_MCP_OAUTH` and the OAuth secrets are process env vars only (never YAML-configurable — resources/mcp-oauth-flag.ts), so they're delivered through a shape-aware secrets-provisioning step (a 0600 staging file the operator applies via Fabric Studio's environment panel or their process manager) — `enable` requires explicit confirmation (`--confirm-secrets-applied`, or an interactive prompt) that the staged vars are live before it calls restart, since restarting without them would just bounce back to the flag-OFF byte-identical boot.
- **Kern's binding condition**: `enable` CONSUMES `src/lib/dcr-client.ts`'s `registerDcrClient` for its DCR interaction (claude.ai pre-registration, an INTERACTIVE client — the CIMD design-record correction confirmed this is DCR's legitimate remaining use) — it never inlines its own POST to `/oauth/mcp/register`. A structural test scans the source for this.
- **Sherlock's Model-2 implementation notes, all honored**: `accessTokenTtl` is explicitly `900` in the written config block, never the plugin's 1h default; the RS256 signing keypair comes from `crypto.generateKeyPairSync`, never a PRNG shortcut; self-verification (hitting `${issuer}/.well-known/oauth-authorization-server` from the operator's machine against the PUBLIC origin) is the exit criterion — on any failure the result names exactly which step to re-run, never reports success on hope.
- **Identity mapping** writes `Credential(kind:"idp")` for the operator's principal (personal-shape default, `--principal`, default `self`) — the SAME credential surface `resources/mcp-handler.ts`'s `resolveAgentFromSub` reads at request time. Idempotent: an existing mapping for (provider, subject) is reused rather than duplicated.
- **Secrets discipline**: every result object carries mechanism/path/var-names only — secret VALUES never appear in a printed step detail, the paste block, or `EnableMcpResult`/`DisableMcpResult`/`McpStatusResult`. A dedicated test serializes a full happy-path result with known sentinel secret values and asserts none of them appear anywhere in the output.
- **`flair mcp disable`**: flag off + restart = byte-identical boot per the Model-2 contract (`resources/mcp-oauth.ts` registers `/mcp` ONLY when `FLAIR_MCP_OAUTH` is truthy) — the `@harperfast/oauth` config block `enable` wrote is left in place since it's inert whenever the flag is off. Same confirmation-gate posture as `enable`'s restart step.
- **`flair mcp status`**: LIVE state, not a stale local marker — hits the same well-known metadata endpoint `enable`'s self-verify step checks. Machine-client count reuses the EXISTING `flair mcp list` manifest machinery (flair#746) rather than a new server call, per Kern's note that `status`/`list` must agree on what a "client" is.

New `src/lib/mcp-enable.ts` (pure/injectable-I/O orchestration, no `process.exit`, no console output — same split as `grantMcpClient`/`revokeMcpClient`) and a `writeDcrTokenFile` addition to `src/lib/dcr-client.ts` (the write half of the token-location contract that module's header already anticipated `enable` needing).

New tests: `test/unit/mcp-enable.test.ts` — local-origin detection (local/private/link-local/mDNS all refused, public origins pass), Fabric-origin secrets-mechanism defaulting, RS256 keypair generation + idempotent key/token reuse, config-block shape (`accessTokenTtl: 900`, `${ENV_VAR}` placeholders never literal secrets), secrets bundle + 0600 staging file + no-values-in-result, identity mapping (create-vs-reuse principal and credential), `set_configuration`-then-`restart` ordering (a failed `set_configuration` never calls restart), DCR pre-registration via `registerDcrClient` (structural: source-scanned for zero inlined `/oauth/mcp/register` calls in actual code), self-verify's four failure modes (unreachable / non-2xx / malformed JSON / issuer mismatch) each with a named `detail`, full 8-step happy-path orchestration with the documented restart-before-DCR ordering asserted, the confirm-secrets-applied gate (zero `set_configuration`/`restart` calls without it), dry-run (zero remote calls), self-verify/DCR failure naming the exact step to re-run, `disable` symmetry (confirm gate → single `restart` call), and `status`'s live-state + local DCR-token + machine-client-count reporting.

### ✨ `flair mcp grant/revoke/list` — named, revocable machine-client provisioning (flair#746)

Completes the #663 client_credentials consumer arc with a paved path from "I have an agent" to "it has credentials and an mcp config block" — the machine-client half of the #719 paved-paths command family (design round: #719's "Paved-paths design round" comment + K&S verdicts).

- **`flair mcp grant <name>`** provisions a named, individually-revocable machine client: a flair Agent + Ed25519 keypair (0600 key files, never printed), registered via the Harper operations API (mirrors `agent add`'s `seedAgentViaOpsApi` shape, plus `runtime: "headless"`). Prints a ready-to-paste `mcpServers` config block (matches `src/install/clients.ts`'s established paste-target shape) referencing the key file path — never inline key material, and never a fabricated static Bearer token (a client_credentials access token is short-lived by design and issues no refresh token, so the config documents the real `flair mcp token` mint-per-session flow instead of printing a token that would already be stale).
- **`flair mcp revoke <name>`** is SERVER-side first: DELETEs the backing Agent record via the admin-authenticated operations API and requires the server's ack before touching anything local. A network error or non-2xx response leaves the local key files and manifest entry completely untouched and exits non-zero with a clear message. Only after a real ack does it delete the local key files and remove the manifest entry (`--keep-keys` preserves the key bytes while still requiring the same server-side ack).
- **`flair mcp list`** reads the local machine-client manifest (`~/.flair/mcp-clients.json`, 0600) — name, client_id, status, created.
- **Ground-truth correction to the #719/#746 design record**: the design round described `grant` as minting a client via "the gated DCR endpoint's client_credentials grant." Reading the published `@harperfast/oauth@2.2.0` source during implementation shows DCR's `POST /oauth/mcp/register` only accepts `authorization_code`/`refresh_token` grant types, and the plugin's client_credentials handler requires a CIMD-resolved client (`client._cimd === true`) — "a stored (DCR) record must never mint here." CIMD (oauth#161, already shipped and consumed by #663's `src/mcp-client-assertion.ts`) is the machine-client registration path that replaced DCR for this exact use case; a flair Agent + Ed25519 keypair IS the registration (`resources/MCPClientMetadata.ts` serves it live and statelessly). `grant`/`revoke` still enforce the DCR gate token as a workflow gate ("prove `flair mcp enable` has run"), layered on Harper's own admin-pass boundary — not a substitute for it, and no loosening of anything K&S asked for, just pointed at the real mechanism. Full citation trail in `src/lib/dcr-client.ts`'s module header.
- **New `src/lib/dcr-client.ts`**: the shared DCR gate-token contract (`FLAIR_MCP_DCR_TOKEN` env, else a 0600 `~/.flair/mcp-dcr-token` file — same name docs/notes/mcp-oauth-model2.md already documents for `dynamicClientRegistration.initialAccessToken`) plus an RFC 7591 DCR HTTP client (`registerDcrClient`), extracted so both this grant family and the future `flair mcp enable` builder read the token from one documented location instead of drifting.
- Does NOT close #719 — `flair mcp enable`/`disable`/`status` and `flair hook install` are separate, not-yet-built slices of the same design round.

New tests: `test/unit/dcr-client.test.ts` (token-location contract precedence, file-permission fail-closed, `registerDcrClient` request shape + error mapping — mocked fetch) and `test/unit/mcp-grant-family.test.ts` (grant happy path, duplicate-name rejection incl. the exact Sherlock-specified message, unrelated-Agent-id collision, insert-failure rollback, revoke's server-ack requirement — including "server 500 leaves local key file untouched" and "network error leaves local key file untouched" — `list` output, 0600 mode checks on both the key file and the manifest, and a direct assertion that `grantMcpClient` performs zero console output).

### ✨ `flair hook install` — ambient memory via SessionStart hooks (flair#745)

Memory reached a Claude Code session through two coupled dependencies: the MCP server being attached, and the model remembering to call `bootstrap`. Both fail in headless shapes (scheduled agents, cron, CI), which ran memory-less. `flair doctor --fix`/`flair init` already wired the same SessionStart hook as a side effect of a bigger flow (flair#588/#597); this adds the standalone, symmetric command family design-reviewed in the "Paved-paths" round ([#719](https://github.com/tpsdev-ai/flair/issues/719)):

- **`flair hook install [--harness claude-code] [--dry-run] [--agent <id>] [--url <url>]`** — idempotent merge into `~/.claude/settings.json`: adds/updates ONLY the Flair SessionStart hook entry (found by the same marker `flair doctor` already checks for), never touches unrelated hooks or keys. Re-running with unchanged inputs is a byte-identical no-op; re-running with a different agent/URL updates that one entry in place (no duplicates). `--dry-run` computes and prints the exact JSON delta without writing anything (no file, no backup — a backup is itself a write). `--harness` defaults to (and today only supports) `claude-code`; an unknown value is a clear error listing supported harnesses.
- **Fails CLOSED on a malformed settings.json**: a backup (`<path>.bak`) is taken *before* the parse attempt, and on a parse error the command reports the problem and refuses to touch the real file — never truncates, never writes a partial replacement.
- **`flair hook uninstall [--harness claude-code] [--dry-run]`** — symmetric removal of only Flair's entry; tidies up an emptied `SessionStart`/`hooks` key rather than leaving litter. A no-op (never creates a file) when nothing is installed.
- **`flair hook status [--harness claude-code]`** — wired? correct shape? which agent/Flair instance does it target (recovered from the wired command)?
- The written command now sets both `FLAIR_AGENT_ID` **and** `FLAIR_URL` explicitly (mirroring `src/install/clients.ts`'s MCP-block wiring), where `doctor`/`init`'s existing minimal shape sets only `FLAIR_AGENT_ID` — this is what makes installing against a remote instance actually target it instead of silently falling back to `flair-mcp`'s localhost default. The added `FLAIR_URL=...` segment never breaks `flair doctor`'s existing `checkSessionStartHook` (still a plain marker-substring match) — zero changes needed to that check.
- Remote-instance transport: the hook payload (`packages/flair-mcp/src/session-start-hook.ts`, unchanged by this PR) authenticates via `FlairClient`'s plain `fetch` — no TLS-bypass anywhere in that chain. New source-scan test asserts it.
- Silent-fast degradation and size-budgeted payload were already implemented in `session-start-hook.ts` (hard timeout, no-op-on-any-failure, bootstrap's own `maxTokens`); new coverage adds a "hanging bootstrap call still no-ops within the configured timeout" test with a mocked client.
- New `src/hook-install.ts` (pure filesystem logic, no network — mirrors `src/doctor-client.ts`'s isolation technique) and `test/unit/hook-install.test.ts` (fresh install, idempotent re-run + in-place update, merge-safety, malformed-file fail-closed, dry-run writes nothing, uninstall removes only ours, doctor-compatibility, TLS-bypass-pattern scan). The degradation-timeout test lives in `packages/flair-mcp/test/session-start-hook.test.ts` instead of `test/unit/` — that file already imports `@tpsdev-ai/flair-client` by its built `dist/`, and CI's root `bun test test/unit/` step runs before the workspace build step.

### ⬆️ harper-fabric-embeddings 0.5.0 — declared pooling verification + metadata-only re-embed identity tripwire (flair#749)

Bumps the pin from ^0.4.0 to ^0.5.0 (resolved 0.5.0 in the tree after `bun install`). 0.5.0 adds opt-in pooling verification (a `pooling` engine option, asserted against the GGUF's own `<arch>.pooling_type` at init — fails loudly on absent/mismatched metadata instead of a metadata-less conversion silently pooling the wrong way) and a resident-addon-binding fix (repeated engine construct/dispose no longer aborts on Metal — relevant to our ephemeral test Harpers). No re-embed: the L2-normalize path is bit-identical hfe 0.2.3 → 0.5.0 (addon pinned exact; verified upstream, hfe#10's probe / hfe#17's docs) — this is a dependency + one config-line change, not a vector-producing change.

- **Pooling declared for the one HFE-registered embedding model.** `resources/embeddings-boot.ts` now passes `pooling: "mean"` in its `register()` config for `nomic-embed-text` — confirmed against the actual shipped GGUF (`node-llama-cpp inspect gguf`: `"nomic-bert": { pooling_type: 1 }`, and llama.cpp's `enum llama_pooling_type` maps `1` to `LLAMA_POOLING_TYPE_MEAN`), not assumed from the model's reputation. flair registers no Qwen3-class (last-token-pooling) embedding model today — the Qwen3-Reranker-0.6B in `resources/rerank-provider.ts` is a separate code path (raw `node-llama-cpp`, generative yes/no scoring, never through HFE's `register()`/`init()`) with no pooling context at all. If a Qwen3-class embedding entry is ever registered, it must declare `pooling: "last"`.
- **flair#749 audit: embedding-identity/re-embed-detection is metadata-only.** Every site that decides staleness or reports embedding-model health compares the `embeddingModel` STRING stamp (`getModelId()`), never vector bytes or a hash of them: `resources/migrations/embedding-stamp.ts`'s `staleCondition()` (embeddingModel `not_equal`/`equals null`), `resources/health.ts`'s memory/agent embedding-model-mix diagnostics (`modelCounts`/`hashFallback`), `src/cli.ts`'s `reembed --stale-only` (a separate build target duplicating the same gate-then-suffix logic as literals), and `resources/Memory.ts`'s dedup gate (`findConservativeDedupMatch`/`runDedupGate`) — the one place flair compares two embedding vectors directly, via a threshold-gated (≥0.95) `cosineSimilarity()` semantic-similarity SIGNAL, never a byte/hash identity check, and ~7 orders of magnitude looser than the ~1e-6-scale cross-environment float drift flair#749 describes. `resources/migrations/source-fields.ts`'s corpus integrity envelope hash structurally excludes `embedding`/`embeddingModel` (`MEMORY_SOURCE_FIELDS` never lists them; they're `MEMORY_DERIVED_FIELDS`), so it can never become a vector-byte identity gate either. No site found comparing vector bytes/hashes across environments.
- **New structural guard**: `test/unit/embedding-identity-tripwire.test.ts` — scans the five audited decision sites above for hash/exact-equality/serialize-for-comparison patterns on a raw embedding vector (`createHash(`, `.digest(`, `embedding ===`/`!==`, `vector ===`/`!==`, `JSON.stringify(embedding)`/`JSON.stringify(vector)`), comment-stripped plain-string scanning only (no dynamic `RegExp`, matching this repo's CodeQL js/regex-injection discipline). Verified locally: planting a `createHash(...).update(JSON.stringify(embedding))...digest(...)` line in `embedding-stamp.ts` makes the new test fail with an exact file:line and an actionable message pointing at flair#749/hfe#17; reverted before commit (confirmed zero diff after revert).

## [0.23.0] - 2026-07-18

### ⬆️ harper-fabric-embeddings 0.4.0 (flair's local-embedding engine)

Bumps the pin from ^0.3.0 (which the caret does NOT extend to 0.4.0 on a 0.x major). Pulls in three upstream fixes flair consumers hit directly: the KV-cache clear between embeds (second embed on one engine instance no longer aborts), automatic Qwen3-class last-token pooling via GGUF metadata, and embedding templates as registry data. Dependency + lockfile only — no flair code change.

### 🐛 `flair upgrade` verification: credential pre-flight, agent-key fallback, honest failure classification (flair#741)

A real 0.22.0→0.22.1 upgrade on a healthy personal machine (no `~/.flair/admin-pass`, no `FLAIR_ADMIN_PASS`) produced the scariest possible report for the mildest possible problem: `❌ post-restart verification failed: ... HTTP 403: no credentials sent`, then `❌❌ ROLLBACK ALSO FAILED VERIFICATION`, then `Instance state is UNKNOWN — do not assume data integrity`. The instance was up the entire time — the verifier simply had no credential material on that machine, a pre-existing condition the upgrade flow never checked. Three defects, all fixed together:

- **Credential pre-flight.** `flair upgrade` now runs the exact same verification call against the CURRENT (pre-upgrade) instance before touching a single package. If that fails specifically because the server responded but rejected the verifier's credentials, the upgrade aborts before any mutation with an explicit "nothing has been touched" message and the provision hint (`FLAIR_ADMIN_PASS` / `flair init`). Gated on `--verify` (skipped by `--no-verify`, the same flag that already opts out of the check this protects). Deliberately does NOT abort when the pre-flight instance is merely unreachable/down — `flair upgrade` may legitimately be the user's way of fixing a down instance, and today's pre-#741 behavior already lets that proceed; only the specific "server up, can't authenticate" case is structurally doomed in a way a fresh install can't fix.
- **Agent-key fallback.** The auth-resolution chain `api()` uses (`--admin-pass`/`FLAIR_ADMIN_PASS`/`HDB_ADMIN_PASSWORD` → agent key → `~/.flair/admin-pass`) only ever tried an Ed25519 agent key when an agent id was ALREADY known (`FLAIR_AGENT_ID` env) — never set by a bare `flair upgrade`, so the agent-key leg was effectively dead for verification even on machines that had a perfectly good key under `~/.flair/keys`. New `verifyAuthedGet()` wraps `api()` and, only when it reports no credential material was available at all, tries every key in `~/.flair/keys` (sorted, first-to-authenticate wins — mirrors `flair doctor`'s key enumeration). Confirmed `/HealthDetail` is NOT admin-gated (`allowRead()` is `allowVerified()`, resources/health.ts — any registered agent, not just admins) so this fallback is sufficient; used for the pre-flight, post-restart, and post-rollback verification calls alike.
- **Failure classification.** A 401/403 from a RESPONDING server during verification now reports "the instance is up and responded — the verifier could not authenticate" and never prints "Instance state is UNKNOWN — do not assume data integrity" (that text is now reserved for genuine connection-refused/timeout/5xx failures, where the instance's state truly can't be determined). Applies to both the post-upgrade and post-rollback verify paths. `ProbeResult` (`src/probe.ts`) gains `authFailureKind: "credentials" | "server" | null`, computed from a `.status` duck-typed off whatever `authedGet` throws (`api()` now throws a status-carrying `ApiHttpError`); a new pure `isCredentialOnlyFailure()` predicate (`src/cli.ts`) is the single decision point behind all three call sites above.

New tests: `test/unit/probe.test.ts` (authFailureKind classification), `test/unit/upgrade-verify-preflight.test.ts` (verifyAuthedGet's agent-key fallback, selection order, and short-circuit-on-real-credential-rejection behavior), `test/unit/upgrade-verify-rollback.test.ts` (isCredentialOnlyFailure predicate; confirms decideAfterVerify/decideAfterRollbackVerify's actual decisions are unchanged by flair#741 — only the messages built around them are).

### ✨ `flair keys prune` — recoverable cleanup of stale/unregistered keys (flair#734)

Follow-up to #731's doctor agent-iteration, which made previously-invisible stale keys visible (each renders as a "not registered" gate finding) but shipped no command to act on it — every `flair doctor` run just re-reported the same noise, and a long-lived dogfood host's key dir kept accreting e2e-test leftovers. `agent remove <id>` already handles the registered case (agent + key together); `flair keys prune` fills the gap for keys with no agent behind them at all.

- **`flair keys prune`** classifies every file in the key dir (`FLAIR_KEY_DIR` / `~/.flair/keys` / `--keys-dir`) into one of four classes: `keep` (registered on the configured instance — never touched, under any flag), `stale` (a valid Ed25519 seed for an agent that is NOT registered), `invalid` (a `.key` file that doesn't parse as an Ed25519 seed at all — reported as its own class, never lumped in with "unregistered"), or `ignored` (non-`.key` files, directories, and its own `.pruned` archive).
- **Dry-run by default** — prints what would move and why, moves nothing. `--apply` actually moves.
- **Never deletes.** Prunable files are MOVED to `<keysDir>/.pruned/<YYYY-MM-DD>/` (UTC date), preserving the original filename; a same-day collision (e.g. two prune runs) gets a numeric suffix (`agentId.key.2`) rather than overwriting the earlier archive.
- **Conservative on reachability**: registration is checked only against the configured default instance (`--instance <url>` to target a different one); if that instance can't be confirmed reachable, the WHOLE run aborts immediately with a non-zero exit — nothing is classified or moved. Never guesses offline.
- Registration checking reuses `checkAgentRegistered` (`src/cli.ts`) — the exact same signed `GET /Agent/:id` doctor's registration gate already uses, not a reimplementation.
- **Doctor integration**: the existing "not registered" gate finding's fix hint (`src/doctor-client.ts` `describeAgentGateFinding`) now points at both remedies — `flair agent add <id>` if the key should be registered, or `flair keys prune` if it's a stale/leftover key. `flair doctor` itself stays read-only; no behavior change beyond the hint text.
- New `test/unit/keys-prune.test.ts` (classification + move + CLI wiring, mocked-fetch + temp dirs, plus two subprocess acceptance checks for the process-exit-code bullets) and new `classifyKeyFile`/`resolveCollisionSafeName`/`pruneDateStamp` pure-logic tests in `test/unit/doctor-client.test.ts`.

### 🧪 Structural guard: `provenance.claimed.*` can never enter an authority decision (flair#735, follow-up to #718)

flair#718's design review (Sherlock) noted that `claimed.model`/`claimed.client` grant zero authority by CONTRACT — never read for read-scope, attribution, dedup, or usage-count decisions — but that contract was enforced only by field naming and code review, not structurally. This is a pure test slice; no runtime code changed.

- New `test/unit/claimed-zero-authority-tripwire.test.ts`: a source-scan test over the actual authority-decision modules — `resources/record-type-kit.ts` (shared read-scope + attribution), `resources/memory-read-scope.ts` (the one Memory read-scope resolver), `resources/Memory.ts`'s dedup gate (`findConservativeDedupMatch`/`runDedupGate`, function-scoped rather than whole-file so Memory.ts's legitimate write-time `claimedClient` stamp/strip in post()/put() isn't a false positive), `resources/RecordUsage.ts` (the real usage-count authority — `Memory.usageCount`'s only writer, feeding `scoring.ts`'s `usageBoost`), and `resources/mcp-handler.ts` (native `/mcp` auth resolution). Fails if any scanned region contains a `claimed.*` read (`claimedClient`, `claimedModel`, `claimed.client`, `claimed.model`, or a parsed-provenance `.claimed` access) — plain-string `includes()` checks, comments stripped first (doc comments legitimately mention the contract in prose), no dynamic `RegExp` (CodeQL js/regex-injection discipline this repo has been burned by twice).
- Verified locally: planting `provenance.claimed.client` inside `record-type-kit.ts`'s `makeAuthGate()` makes the new test fail with an actionable message (file:line, offending token, and a pointer to move the read out of the authority module); reverted before commit.

### 🧹 MCP surface — declare-and-enforce, not runtime-derive; no behavior change (flair#520 slice 3)

Slice 2 (#730) landed `resources/record-types.ts`'s `RECORD_TYPES` registry with an `mcp` field that was shape-only, consumed by nothing. Slice 3 backfills it and adds enforcement, per the design round on the #520 issue thread (Kern's DESIGN REVIEW — APPROVE all four asks; Sherlock's Security Review — APPROVE with one refinement, adopted).

An audit of the 12 shipped `/mcp` tools (`resources/mcp-tools.ts`) found only 5 are simple table-verb wrappers (`memory_get/store/delete`, `soul_get/set`); the rest are composite or bespoke (`bootstrap`, `attention`, `memory_search`, `memory_update`, `record_usage`) and can't be generated from a registry entry without either losing schema/behavior specifics or duplicating the handler. So the registry does not generate tools — it DECLARES the reviewed MCP surface, and a new bidirectional test enforces that declaration and reality never drift:

- `RECORD_TYPES.<Table>.mcp` backfilled on four of the five core entries, documenting the CURRENT shipped surface exactly (registration, not behavior change): Memory (`get`/`search` reads, `store`/`delete`/`update` writes), Soul (`get` read, `store` write), WorkspaceState (no reads, `store` write), OrgEvent (no reads, `store` write). Relationship stays `mcp`-absent — it has no MCP tool today.
- `RecordTypeMcp.writeVerbs` gains `"update"` (additive), documenting `memory_update`'s already-shipped two-branch read-modify-write — not a new capability.
- New top-level `COMPOSITE_MCP_TOOLS` export in `record-types.ts` (deep-frozen, `["bootstrap", "attention", "record_usage"]`) — the second and only other reviewed chokepoint, for tools that don't map to a single table + verb. Per Sherlock's refinement (Kern concurring): this lives in `record-types.ts`, not `mcp-tools.ts`, so the FULL MCP surface is reviewable in one file.
- New `TOOL_NAME_OVERRIDES` in `resources/mcp-tools.ts` covers the three naming quirks where the shipped tool name isn't the default `${toolPrefix}_${verb}` shape: `(Soul, store)` → `soul_set`, `(WorkspaceState, store)` → `flair_workspace_set`, `(OrgEvent, store)` → `flair_orgevent`. Registry declares WHAT is exposed; `mcp-tools.ts` owns HOW (names, defaults, routing).
- New `test/unit/mcp-surface-tripwire.test.ts`: bidirectional CI enforcement — every declared registry verb must resolve to a tool that exists in `TOOLS`, every tool in `TOOLS` must be either derived from a declared verb or listed in `COMPOSITE_MCP_TOOLS`, a table with no `mcp` field contributes zero tools carrying its prefix, and the full 12-tool `tools/list` surface is pinned as a golden value. Any future PR that adds or removes an MCP tool must now also touch one of the two reviewed chokepoints, or CI fails.
- `test/unit/record-types-registry.test.ts`'s slice-2 "no entry sets mcp" assertion flips to golden-value pins of the four backfilled declarations plus a pin of `COMPOSITE_MCP_TOOLS`'s contents.
- Fixed a stale comment in `mcp-tools.ts`'s `listToolDefs` ("exactly the 9 curated tools" — actual: 12, wrong since `attention`/`record_usage` were added).

Zero runtime behavior change: `tools/list` output is byte-identical, `resources/mcp-tools.ts`'s `TOOLS` dispatch table is untouched apart from the name-override structure and the comment fix, and every existing `mcp-handler.test.ts` assertion passes unchanged. The diff is registry data + tests + two comment fixes.

### ✨ Authorship provenance — `claimed.client` records which client wrote a row (flair#718)

An audit of the identity machinery reframed this from "add a personal-vs-org deployment mode" to a narrower, cheaper fix: the personal shape (one shared principal across every AI client, via `flair init`) already ships and is correct — what's missing is recording *which client* authored a write once several clients share one principal. K&S-approved design (issue #718): no new config key (deployment shape stays emergent from provisioning, now documented in `docs/auth.md`), authorship recorded in the existing `claimed` (self-reported, unverified) provenance slot rather than a first-class row field.

- **`resources/provenance.ts`**: `buildProvenance` gains `claimed.client`, sourced from a write-body-only `claimedClient` field (deliberately distinct from the stamped output key). Shares a new `sanitizeClaim()` helper with `claimed.model` — both now get the SAME discipline: string-only, control-character-stripped, trimmed, length-capped at 200 chars, dropped if empty after sanitizing (Sherlock flair#718 refinement: `claimed.model` previously had only a truthiness check).
- **Write paths** (`resources/Memory.ts` post()/put(), `resources/Relationship.ts` put()): thread `claimedClient` into `buildProvenance`, then strip it from the row before persisting — authorship lives in the `provenance` JSON only, never as a second top-level field.
- **Native `/mcp` OAuth path** (`resources/mcp-handler.ts`, `resources/mcp-tools.ts`): the handler stamps `claimed.client` from the verified token's `client_id` claim (the server-generated `flair_cl_...` machine id) — **never** `client_name` (user-controlled at Dynamic Client Registration), per Sherlock's binding refinement. `ResolvedAgent` gains an optional `clientId`, threaded into `memory_store`/`memory_update`'s write bodies; no client-side cooperation needed for this surface.
- **`packages/flair-client`**: `FlairClientConfig.claimedClient` (or the `FLAIR_CLIENT` env var) is forwarded on `memory.write()`/`memory.update()` payloads when set; absent by default — zero behavior change for existing installs. **`packages/flair-mcp`** forwards its own `FLAIR_CLIENT` env into the client it constructs.
- **`flair init`**: each client's wired env block (Claude Code, Codex, Gemini, Cursor) gains `FLAIR_CLIENT` set to that client's own id. Optional/additive — `flair doctor --fix`'s re-wiring path is unchanged (no FLAIR_CLIENT, deferred).
- **Zero authority, by construction**: `claimed.client` is self-reported, unverified metadata — it is never read for access control, read-scope, attribution weighting, or dedup decisions anywhere in the codebase. `docs/auth.md` gets a new "Deployment shapes: personal vs org" section documenting the existing personal/org provisioning distinction and this field's role in it.

Out of scope for this slice (explicitly, per the design record): new config keys, per-client credentials, row backfill, trust scoring, `flair doctor` rendering changes, and provenance stamping for Soul/WorkspaceState/OrgEvent (neither stamps provenance today).

### ✨ `flair doctor` now iterates every identifiable agent for its verified-read sections, instead of hiding them behind `--agent` (flair#722)

`doctor`'s "Fleet presence" and "Migrations" sections need a signed (Ed25519) request to reveal server-verified fields (flairVersion/harperVersion, migration state) — previously that meant passing `--agent <id>` explicitly, even though doctor already enumerates every key in `~/.flair/keys` (the `Keys found: N agent(s)` line). A real 0.22.0 dogfood run found the flair#720 halted-migration warning visible via `flair status --agent local` but invisible in the default `doctor` run the same user ran minutes later.

- **Default run now iterates every key** in `~/.flair/keys`, running the signed read for each as a per-agent subsection (`Agent: <id>`) under Fleet presence and Migrations. A typical single-agent install gets exactly one subsection — same information as passing `--agent` today, just automatic.
- **`--agent <id>` becomes a filter** — unchanged semantics: still a single signed identity, just no longer implicitly widened to "every key" when omitted.
- **Failure isolation**: a bad or unregistered local key reports as that agent's own finding (`not registered` → `flair agent add <id>`, or `no local key`) without aborting the other agents' subsections or the rest of the run. The registration gate is resolved once per agent and shared by both sections: the finding renders in full once (under Fleet presence, the first verified-read section) — Migrations rolls gate-failed agents into a single aggregate skip line rather than duplicating each finding — and it's counted once toward the found/fixed/remaining summary (flair#721). These findings are found-only; no `--fix` action exists for them.
- **Zero local keys** (and no `--agent`) falls back to exactly the pre-#722 behavior: a single unauthenticated read with hidden versions and a "Pass --agent" hint for Fleet presence, and the same hint (no fetch) for Migrations — identities are public regardless of the gate, only the verified fields require it.
- Instance-level checks (server up, version handshake, config, embeddings probe, client integrations) are unaffected — they still run exactly once, not per agent.

New pure helpers in `src/doctor-client.ts` — `planAgentIterations()` (which agent ids to iterate) and `describeAgentGateFinding()` (render + found-summary decision for one agent's registration-gate outcome) — unit-tested in `test/unit/doctor-agent-iteration.test.ts`. Integration coverage (`test/integration/doctor-fleet-presence.test.ts`) exercises auto-iteration of a real local key, the zero-keys fallback, and failure isolation against a real spawned Harper.

### 🧹 RecordType registry — the declared policy layer over the record-type kit, no behavior change (flair#520)

New `resources/record-types.ts`: a static, PR-reviewed `RECORD_TYPES` map naming, per table, which read-scope model it uses, which no-forge attribution idiom it stamps on each write method, whether it stamps provenance, whether it carries an embedding column, and whether it participates in federation — the capability set the flair#520 design draft's §4 laid out, refined by Kern and Sherlock's DESIGN REVIEW on the issue thread (readVerbs/writeVerbs structurally split even though MCP wiring is slice 3 — the shape lands now; `readScope` narrowing called out as a breaking change distinct from the additive-only discipline; federation defaults to excluded for any future non-core type). The five core entries (Memory, Relationship, WorkspaceState, OrgEvent, Soul) document each table's CURRENT shipped behavior exactly — this is a registration layer, not a behavior change: Memory (`open-within-org` read, `validate-truthy` attribution on both post/put, provenance, `content` embedding), Relationship (`owner-only`, `stamp-strict` on put only — no post override), WorkspaceState (`owner-only`, `stamp-default` on post / `validate-strict` on put, no provenance), OrgEvent (unscoped reads — no get()/search() override exists, same as before; `stamp-default`/`validate-strict`, `authorId` as its owner field), Soul (unscoped reads, `validate-truthy` on both via its shared `enforceWriteAuth` helper, no provenance). `Memory.ts`/`Relationship.ts`/`WorkspaceState.ts`/`OrgEvent.ts`/`Soul.ts` now draw their `record-type-kit.ts` parameters (read-scope mode/ownerField, attribution mode) from their `RECORD_TYPES` entry instead of hand-typed literals — a single source of truth per table, with the registry itself deep-frozen at load so a runtime mutation attempt throws rather than silently desyncing from what a resource file composed.

One disclosed extension beyond the design draft's two-value `readScope` shape (`owner-only` | `open-within-org`): a third value, `none`, names the real state `record-type-kit.ts`'s own slice-1 file header already called out — OrgEvent and Soul have no get()/search() override at all, so any verified agent reads every row, unscoped by owner, with no visibility field in play. That's neither of the two K&S-approved models (broader than owner-only, no private-visibility exception the way open-within-org has one) — labeling it "owner-only" to force the binary would be a false registry entry. Flagged here for K&S review rather than silently reinterpreted. `embedding`/`federation`/`mcp` fields are declared per this slice's explicit scope but NOT wired: Memory's embedding logic stays exactly where slice 1 left it (dedup-gate-entangled inline code, not routed through this registry); `federation` documents what Federation.ts's/src/cli.ts's already-hardcoded table lists do per type without driving them; `mcp` is shape-only (`readVerbs`/`writeVerbs`, per Kern/Sherlock's structural split) and consumed by nothing — flair's existing hand-written `/mcp` surface (`resources/mcp-tools.ts`) remains the sole, unrelated MCP wiring for these tables. No `contentSafety` field, per Kern's explicit v1 verdict (optional, not mandatory — deferred to a follow-up once a concrete type needs it).

New `test/unit/record-types-registry.test.ts`: registry shape/exhaustiveness validation, a golden-value pin per table (independent of `record-types.ts`, so an accidental registry edit that drifts from shipped behavior fails even though nothing else in the suite would catch it), deep-freeze/immutability checks, and a source-text drift tripwire confirming each of the five resource files actually draws its kit parameters from `RECORD_TYPES.<Table>` rather than a reintroduced literal (chosen over importing the five resource classes directly, which would risk the cross-file Harper-mock module-cache collision `memory-soul-read-gate.test.ts`'s own header already documents). `record-type-kit.ts`'s `makeReadScope()` now tags its returned resolver with `.mode`/`.ownerField`, pinned directly by new `test/unit/record-type-kit.test.ts` coverage — a mock-free primitive-level hook a future single-resource-file test can use for the same check. Existing behavior-test suites for all five tables pass unchanged — the acceptance bar throughout is byte-identical runtime behavior; only where each table draws its literals from changed.

### 🧪 Test infra: process-isolate module-mocking unit files — fix latent `bun test` poisoning (flair#691)

Three unit files `mock.module("resources/embeddings-provider.ts")`. `bun test` runs many files per process and `mock.module` is process-global and never restored, so a mocker poisoned that module for every later file in its process — real-importer files (directly, or transitively via Memory.ts) then got the stub. Latent until the unit-test file count shifted bun's multi-worker scheduling to co-locate a mocker before a victim, turning unrelated PRs red. Verified dead-ends: `mock.restore()` does not revert `mock.module` (bun 1.3.10); re-mocking in `afterAll` cannot fix an already-frozen static `import` binding.

- Moved the three mockers to `test/unit-isolated/`; CI and `release.sh` run that directory as a SEPARATE `bun test` invocation (fresh process → no cross-file poisoning).
- New `mock-isolation-tripwire.test.ts` fails if a file in `test/unit/` mocks an isolated shared module, so a future mocker can not silently re-arm the bug.

### 🐛 `flair doctor`'s Codex wiring printed a broken FLAIR_URL and needlessly forced manual mode on an existing config.toml (flair#727)

Two defects in doctor's Codex client-integration fix path, found on a real 0.22.1 dogfood run against a second machine.

- **Broken `FLAIR_URL`.** When a stale/malformed value was scraped from an existing (partially-wired) `~/.codex/config.toml` — e.g. a bare host with no scheme or port, left over from an older Flair version or a hand-edited file — `doctor --fix` reused it verbatim in the freshly suggested block: `FLAIR_URL = "127.0.0.1"`, unusable if pasted. New `resolveWireFlairUrl()` (`src/doctor-client.ts`) only trusts an existing value when it parses as an absolute `http(s)://` URL; otherwise it falls back to the live, authoritative URL doctor already computed from the same port source as its `Config: ... (port: NNNNN)` line. This call site is shared by all four clients (Claude Code, Codex, Gemini, Cursor), so the fix applies uniformly — the other three clients' JSON templates were checked for the same class of bug and found clean (they always rendered the URL they were given; the bad value only ever originated at this one construction site).
- **Existing `config.toml` no longer forces manual wiring unconditionally.** `_wireCodex` (`src/install/clients.ts`) used to refuse to touch any pre-existing file, regardless of content. Appending a `[mcp_servers.flair]` table at EOF is safe TOML when that exact header isn't already present, so it now greps for the header (`codexConfigHasFlairSection`) and appends (`appendCodexFlairBlock`, with the same blank-line separator convention as `fixClaudeMdBootstrap`) when missing, or reports `already wired` (idempotent, no write) when present — matching the JSON clients' existing idempotency contract. The manual-print fallback is now reserved for the genuinely unreadable/unwritable case (permissions, I/O error) — and that fallback's block renders the same corrected, always-authoritative URL.

### 🧹 Record-types kit extraction — one shared auth/scope/attribution implementation instead of five hand-copies (flair#520)

`resources/Memory.ts`, `Relationship.ts`, `WorkspaceState.ts`, `OrgEvent.ts`, and `Soul.ts` each independently hand-copied ~150-250 lines of near-identical agent-identity gating: `resolveAgentAuth()` three-way branching (internal/agent/anonymous), 404-never-403 non-owner by-id reads (so a denied caller can't enumerate other agents' record ids), and no-forge attribution (agentId/authorId stamped from the verified identity, never the request body). Every `allowRead()` docstring literally said "same pattern as X.ts" — the pattern was a documented convention, not shared code, which is exactly how the memory-soul-read-gate P0 family had to be independently rediscovered and fixed table-by-table.

New `resources/record-type-kit.ts` extracts the genuinely-identical primitives into parameterized helpers — `makeAuthGate()` (the `allowRead()` gate), `resolveAuthGate()` (the three-way auth dispatch shared by `get()`/`search()`/`delete()`), `makeReadScope(mode, ownerField)` (`'owner-only'` for Relationship/WorkspaceState, or `'open-within-org'` delegating to Memory's existing `resolveReadScope()`/`PRIVATE_VISIBILITY` semantics unchanged), `makeByIdReadGate()` (the 404-never-403 by-id read gate), `stampAttribution()` (four named no-forge idioms — `validate-truthy`, `validate-strict`, `stamp-default`, `stamp-strict` — matching the real, distinct security postures found across the five tables' write paths verbatim, not merged into one), and a re-exported `buildProvenance` (unmodified, reused as-is per the existing relationship-write-path contract). All five resource classes now compose the kit; each keeps its own type-specific business logic (dedup gating, embedding, entity-vocabulary validation, query-merge shape) inline and visible — only the copied auth/scope/attribution boilerplate moves into the shared kit.

Pure refactor: no new features, no registry, no MCP changes (tracked separately as later slices of #520). Security rationale for landing this as its own change: a single reviewed implementation of the read-gate family closes the class of bug where the same fix had to be found and applied five separate times — a sixth hand-copy (or a missed spot in a future fix) is no longer possible by construction. Behavior is byte-identical, including each table's real divergences (Memory.delete()'s permanent-durability-only gate with no ownership check, Soul's deliberate absence of a get() override, OrgEvent's fully-open reads beyond the auth gate, WorkspaceState.post()'s unconditional-stamp-no-rejection vs. put()'s reject-on-mismatch) — the existing behavior-test suites for all five tables pass unchanged. New `test/unit/record-type-kit.test.ts` adds kit-level unit coverage for both read-scope modes, the auth three-way branch, the by-id 404-never-403 gate, and every `stampAttribution` idiom.

## [0.22.1] - 2026-07-14

### 🐛 Migration disk-headroom pre-flight blocked trivially-small migrations on normally-full personal disks (flair#720)

`checkSpace()` (`resources/migrations/space.ts`) required a migration's needed bytes to fit AND that spending them not push disk usage past 90% of TOTAL disk size — a rule designed for a flair-dedicated volume. On a general-purpose machine (a personal Mac especially, where APFS purgeable space makes `statfs.bavail` understate real availability) the system volume routinely sits above 90% used already, so every migration halted regardless of its own footprint: the first 0.22.0 boot on such a disk halted the `embedding-stamp` migration needing 220 KB with 18.6 GB free.

- **New rule**: `ok = neededBytes <= freeBytes AND (freeBytes - neededBytes) >= reserve`, where `reserve = clamp(5% of total disk, 256 MiB, 2 GiB)`. Only the migration's own impact on free space is judged now, not the disk's pre-existing fullness — `RESERVE_MIN_BYTES` / `RESERVE_MAX_BYTES` / `RESERVE_FRACTION` (new named exports in `resources/migrations/space.ts`).
- **`FLAIR_MIGRATION_RESERVE_BYTES`** overrides the computed reserve for constrained deployments (validated finite/non-negative; `0` disables the reserve check entirely, leaving only the raw fit test) — mirrors the existing `FLAIR_MIGRATION_TEST_FREE_BYTES` test-override pattern.
- **`headroomFloor`** (the old fraction-of-total DI knob on `checkSpace`/`runMigrationCycle`) is removed — it was never wired from production config, only ever exercised by the fraction-based tests this fix rewrites, and the new rule has no fraction to override (the env var above is the operator-facing lever now).
- **Failure message rewritten to be truthful and actionable**: no longer suggests pruning snapshots or `FLAIR_SNAPSHOT_DIR` (neither changes the `dataDir` volume's fraction and never could have helped this class of halt) — now states the human-readable bytes needed vs. available vs. the reserve, and names `FLAIR_MIGRATION_RESERVE_BYTES` as the remedy for constrained setups. All byte quantities in the message are formatted human-readable (e.g. `220.0 KB`, `17.37 GB`, `2.00 GB`) via a new `humanBytes()` export, never raw byte counts — structured fields (`SpaceCheckResult`) still carry raw numbers for machine consumers.

### 🐛 `flair doctor --fix` reported issues found and exited 1 even after fixing everything (flair#721)

`doctor --fix` tracked a single `issues` counter — every detected problem incremented it, and the summary/exit code read only that counter, with no record of which of those issues `--fix` actually resolved during the same run. A run that interactively fixed every issue it found (e.g. wiring an MCP client, adding the Claude Code SessionStart hook) still printed `N issues found — see fixes above` and exited 1, indistinguishable from a run that fixed nothing — breaking scripted use (`flair doctor --fix && ...`).

`doctor` now tracks fixed-vs-remaining explicitly: each check that offers an in-run fix (port-drift config rewrite, dead-Harper restart, version-mismatch restart, stale PID-file removal, MCP client wiring, CLAUDE.md bootstrap line, SessionStart hook) counts toward a separate `fixed` total only when that fix actually succeeds, not merely attempted or declined. The summary now reads: all fixed → `N issues found, N fixed ✓` and exit 0; some remaining (declined prompts, unfixable checks, `--dry-run`) → `N issues found, M fixed, K remaining` and exit 1; zero issues → unchanged `No issues found` / exit 0. Without `--fix`, behavior is unchanged: `N issues found — see fixes above` / exit 1. The decision logic is extracted into a pure `summarizeDoctorRun(found, fixed, autoFix)` helper, unit-tested directly (`test/unit/doctor-summary.test.ts`).

## [0.22.0] - 2026-07-13

### ⬆️ Upgrade notes

Read this before upgrading from 0.21.0. Three of the four items below change default behavior; none require a manual command, but the first boot after upgrade does more work than a typical patch bump.

- **`authorizeLocal` now defaults to `false` (flair#654, #671).** Already shipped in this Unreleased batch (see existing 🔒 Security entry) but worth restating at the top: a credential-less loopback call to Harper's raw ops API (:9925) that used to be auto-authorized as `super_user` now gets rejected. The admin credential (`~/.flair/admin-pass`, `--admin-pass`, or `FLAIR_ADMIN_PASS`) is now load-bearing for any local tooling that talks to the ops API directly. `flair init`/`agent add`/`principal add` are unaffected (they already passed real credentials). To restore the old, less-safe behavior for local dev only, set `authorizeLocal: true` in `config.yaml`. Not remotely exploitable either way — this only ever governed loopback.

- **Embeddings re-embed automatically on first boot — no manual step, but it takes time.** #700 flips `EMBEDDING_PREFIXES_ENABLED` to `true`, which changes `getModelId()`'s output (rows now stamp `<model>+searchprefix` instead of the bare model id). Every memory written under 0.21.0 or earlier reads as stale under the new stamp. The always-on `embedding-stamp` migration (part of the zero-touch auto-migration runner shipped in #690) picks these rows up and re-embeds them automatically on the first boot that reaches them — this is stated as intentional in #700's own PR description ("this is intended, not incidental — it's this migration's first real payload since it shipped"). Nothing to run by hand; `flair reembed --stale-only` exists if you want to trigger it deliberately instead of waiting for boot. The migration runner enforces a 90%-disk-headroom pre-flight check, takes a risk-scoped snapshot before running, and halts (rather than partially completing) if it can't proceed safely — see the migration-runner section below. Neither PR states an expected re-embed duration for a production-sized corpus — budget first-boot time proportional to corpus size; don't assume it's instant.

- **Embeddings config registration changed mechanism (again) mid-release — the version you're actually getting is the safe one.** #685/#689 initially registered the embeddings backend via Harper's `HARPER_CONFIG` env var, which turned out to *persist* into `harper-config.yaml` and brick a downgrade back to 0.21.0 (flair#694, root-caused in #698's PR body: Harper's env-config layer deletes the persisted keys individually when a build that predates the feature boots without setting the env var, and the resulting `models: {embedding: {default: {}}}` fails Harper's own config validator on the *next* boot). #698 (merged before the prefix flip landed) replaced this with fully in-process registration (`resources/embeddings-boot.ts` calls `harper-fabric-embeddings`'s own `register()` factory directly on every boot) — **nothing is ever written to `harper-config.yaml`** for embeddings config as of this release. No operator action needed; flagging so you know the mechanism is reassert-only, not persisted, if you go looking for it on disk and don't find it.

- **REM execute-mode is now the default for `flair rem rapid` and requires manual Harper config to actually run.** `flair rem rapid` now calls Harper's `models.generate()` server-side and stages `MemoryCandidate` rows by default, instead of just printing a prompt for you to paste elsewhere. `--prompt-only` restores the exact pre-0.22.0 prompt-return behavior (no model call, no staging). For execute-mode to work at all, an operator must add a `models:` block to **Harper's root instance config** (`harper-config.yaml`/`harperdb-config.yaml` at the Harper data directory) — *not* flair's own `config.yaml`, which Harper only ever loads as a non-root component config. The specific key is `models.generative.<logicalName>` (distinct from embeddings' `models.embedding.default` namespace under the same root block). Verified example from the now-shipped `docs/rem.md` (origin/main, via #711), local zero-key Ollama default:
    ```yaml
    # harper-config.yaml
    models:
      generative:
        default:            # unset FLAIR_REM_MODEL resolves to this logical name
          backend: ollama
          host: localhost:11434   # optional — already the default
          model: llama3.1         # required — Ollama has no built-in default model
    ```
    Hosted providers (OpenAI/Anthropic/Bedrock) are supported the same way under a different logical name (e.g. `models.generative.hosted`), selected via `FLAIR_REM_MODEL=hosted`; `apiKey` must be `${ENV_VAR}` indirection, never a literal in the YAML (flagged at Harper boot) — on Fabric this env var is provisioned through Harper's own Fabric secrets mechanism (`enc:v1:` at rest), a Harper-side concern flair's own `docs/secrets-and-keys.md` does not cover. **Pointing this at a hosted provider sends the memory content being reflected on to that provider** — the docs call this out explicitly as a "data egress is a configuration decision" warning; local Ollama is the only backend that keeps everything on-box.
    If no `models:` backend is configured, `flair rem rapid` (execute-mode) and the nightly runner's distillation step both fail closed (503 `no_backend`) — the nightly runner logs it into the audit row's `errors[]` and otherwise proceeds normally, so an un-configured instance is not broken, it just never gets execute-mode REM until a backend is configured.
  - **Non-thinking model requirement.** Per real dogfooding (documented in `docs/rem.md` via #713): thinking/reasoning models (`qwen3-next`, `deepseek-r1`, and similar) "currently return empty generations through Harper's Ollama backend: Ollama routes their output into the response's `thinking` field, which the backend doesn't read, so every REM execute run fails closed with `distillation_failed`" — an availability failure, not a correctness one (zero partial/bad candidates). Use a non-thinking model (`llama3.1`, `qwen3-coder-next`, `gemma3`, …) instead. Dogfooded successfully: `qwen3-coder-next` staged 7 quality candidates in ~7s, dedup held on a second run, a promoted candidate landed with `derivedFrom` intact.
  - **Nightly cycle now spends model tokens/compute nightly**, once a backend is configured — step 5 of the nightly runner calls `/ReflectMemories` with `execute: true` after maintenance succeeds (skipped entirely under `--dry-run`). This is a new recurring cost that didn't exist pre-0.22.0; there is no separate opt-out from the nightly step short of not configuring a `models:` backend.
  - **Review loop is unchanged and still the only promotion path**: `flair rem candidates` lists pending rows, `flair rem promote <id> --rationale "<why>"` / `flair rem reject <id> --reason "<why>"` decide them — nothing self-promotes, execute-mode or not.
  - **Clustered/Fabric deploys**: `flair rem nightly enable` installs a platform timer (launchd/systemd) on whichever single node runs the command — v1 requires picking exactly one node deliberately (enabling on every node would run the cycle N times); this is a pre-existing v1 constraint, not new in 0.22.0, but worth knowing before enabling nightly REM on a multi-node deploy. Snapshot locality follows the timer's node.

### 🌙 REM: in-process distillation — `/ReflectMemories` execute mode (flair#707, #708, #710, #711)

REM (**Reflect · Extract · Merge**) is flair's memory-curation cycle — it reads an agent's recent memories, distills them into candidate insights, and stages those as reviewable rows for explicit promotion; nothing self-promotes. Before this slice, `/ReflectMemories` could only return a *prompt* for a human or another agent to paste into an LLM elsewhere — the actual distillation step was always a manual handoff (`flair rem rapid` produced homework, not results). This slice closes that gap: REM now executes reflection itself, in-process, against Harper's own model-serving surface, and stages the result as reviewable `MemoryCandidate` rows directly. Three PRs: a K&S-reviewed spec (#708), the resource-level execute mode (#710), and the nightly runner + CLI + docs wiring (#711).

- **`execute: true` on `POST /ReflectMemories`** (`resources/MemoryReflect.ts`, `resources/memory-reflect-lib.ts`) runs distillation server-side via `models.generate()` — schema-constrained output on the first attempt, a `json`-mode fallback with one retry on malformed output, fail-closed (no retry) on a thrown network/timeout error. Validated output stages `MemoryCandidate` rows: shape validation, `sourceMemoryIds` checked as a subset of the gathered memory set, named-constant batch caps. `execute: false` (the pre-0.22.0 behavior) still returns a prompt only — nothing changed there.
- **Data-not-directives hardening applies to both modes**: memory content is now delimiter-wrapped (`<memory id="…">…</memory>`, replacing the old bracket-list prompt format) with an explicit instruction that memory content is data, not instructions — closes a prompt-injection-shaped surface where a memory's own content could otherwise be read as directives by the distillation call.
- **Backend is pluggable, zero provider code in flair**: whatever Harper's `models.generative.<logicalName>` config points at — local Ollama by default (zero-key, nothing leaves the box), or a hosted OpenAI/Anthropic/Bedrock backend selected via `FLAIR_REM_MODEL`, with the API key required to be `${ENV_VAR}` indirection (never a literal in the YAML) and, on Fabric, provisioned through Harper's own Fabric secrets mechanism (`enc:v1:` at rest) — a Harper-side concern, not something flair's own code implements. Verified against `@harperfast/harper` 5.1.17: `responseFormat: { schema }` is honored by the Ollama/OpenAI backends; Anthropic accepts but ignores it, so output is independently re-validated regardless of which backend is configured. `generatedBy` on a staged candidate is the configured logical model name — the pinned Harper version's `GenerateResult` carries no model id of its own. Docs lead with an explicit "data egress is a configuration decision" warning: pointing at a hosted provider sends the reflected-on memory content to that provider.
- **Nightly runner step 5** (`src/rem/runner.ts`): after the existing maintenance step succeeds, the nightly cycle calls `/ReflectMemories` with `execute: true`. The audit row gets `slice: "2"` whenever distillation was attempted (success or failure) with staged candidate ids on success or a `distillation:` entry in `errors[]` on failure — maintenance results stand either way, a distillation failure never fails the whole nightly cycle. `--dry-run` skips the distillation call entirely (staging rows and spending model tokens are real side effects, deliberately not exercised in a dry run).
- **CLI**: `flair rem rapid` executes by default now and prints a staged-candidate summary with a review hint; `--prompt-only` preserves the exact pre-#710 prompt-return behavior byte-for-byte. Distinct error messaging for a 503 no-backend response (points at the docs) versus a 502 distillation-failed response (suggests retry or `--prompt-only`). `rem nightly run-once` now also surfaces the staged-candidate count.
- **Config note (load-bearing, verified against Harper 5.1.17 source):** the `models:` block must live in Harper's **root instance config**, not flair's own `config.yaml` — flair always loads as a non-root component, so Harper never reads a `models:` block from component config. New `docs/rem.md` (linked from the README) documents this prominently, plus the `FLAIR_REM_MODEL` env var, the clustered-deploy single-timer rule, and the snapshot-locality note.
- **Non-thinking model requirement** — thinking/reasoning models' output lands in Ollama's `thinking` response field, which Harper's Ollama backend never reads, so an execute-mode call against a thinking model always fails closed with 502 `distillation_failed`. REM's fail-closed posture held throughout (zero partial candidates, no leakage) — this is an availability gap, not a correctness one. A non-thinking model (dogfooded: `qwen3-coder-next`, 7 quality candidates staged in ~7s, dedup held on a second run, promotion preserved `derivedFrom`) is required. Documented in `docs/rem.md` (#713).
- Deferred to a later slice, called out explicitly in #710's PR body: `tags` is schema-validated on a candidate but not persisted (`MemoryCandidate` has no `tags` column yet).
- Tests: hermetic suite grew from 2225 to 2365 passing across the two implementation PRs (0 failures); strict typecheck clean on all three configs.

### 🧬 Native embeddings — Phase 1 (`models.embed`) + search-prefix flip (flair#504, #685, #686, #689, #698, #700, #701)

Multi-PR migration off flair's own hand-rolled `harper-fabric-embeddings` init/addon-discovery code, onto Harper's native `models.embed()` facade — tracked end-to-end under flair#504.

- **Phase 1 — infra swap, dead-flat wash (#685).** `resources/embeddings-provider.ts`'s `getEmbedding()` now calls `models.embed(text, {model: "default"})` instead of dynamic-importing `harper-fabric-embeddings` and hand-rolling init; the `@node-llama-cpp/<platform>` addon-discovery + VM-sandbox init block is deleted outright. `harper-fabric-embeddings` bumped 0.2.3 → 0.3.0. No `inputType` was passed in this phase (byte-identical output to pre-migration). Measured on the recall-eval harness (3 runs, hybrid on): **exact zero delta** — p@3=0.967, MRR=0.892 both before and after, SE=0.000. Full unit (1979/1979) and integration (259/259) suites green before and after.
  - A real, separately-filed upstream finding surfaced along the way (not fixed here, not currently observable in recall numbers): `harper-fabric-embeddings` 0.3.0's `l2NormalizeInPlace` casts to `Float32Array` before dividing by the norm (0.2.3 divided in double precision first), a reproducible ~5.85e-8/dim relative difference.
  - #686 is a same-day docs-only follow-up correcting stale `HARPER_SET_CONFIG` references to the mechanism actually shipped, and clarifying that Harper's global `models` export and a component's `scope.models` are the same boot-time singleton (not two things).
- **`inputType` plumbing + the prefix gate, initially parked (#689).** Added `EmbedInputType` (`'document' | 'query'`) plumbing through every `getEmbedding()` call site, and a single chokepoint constant `EMBEDDING_PREFIXES_ENABLED` in `embeddings-provider.ts` that atomically controls both whether `inputType` is forwarded to `models.embed()` and whether `getModelId()` appends a `+searchprefix` suffix (the two can never diverge by construction). Landed with the gate **off** — K&S reviewed an N=126-query A/B (`prefixes=on` vs `off`) and ratified parking the flip: Δp@3 −0.016, ΔMRR −0.003, noise-scale at this instrument's N, not a directional signal. Also shipped `test/bench/recall-harness/BASELINE.json` as the frozen reference point a later flip would need to re-baseline through.
- **Downgrade-safety bug + fix (flair#694, #698).** The interim registration mechanism (`HARPER_CONFIG` env var) persisted `models.embedding.default` into `harper-config.yaml`. Downgrading to a pre-#685 build (which never sets `HARPER_CONFIG` because the feature didn't exist yet) made Harper's env-config layer delete the persisted keys individually with no stored original — leaving `models: {embedding: {default: {}}}` on disk, which fails Harper's config validator on the *next* boot with `'models.embedding.default.backend' is required`. Reproduced via a real three-boot repro (published 0.21.0 → this build → 0.21.0 again). Fixed by moving registration fully in-process (`resources/embeddings-boot.ts` calls `harper-fabric-embeddings`'s `register()` factory directly on every boot, loaded via the existing `jsResource` glob) — nothing is ever persisted to `harper-config.yaml`, so there's no downgrade bug class left to hit. Verified: the same three-boot repro now boots clean at every step, plus a live embed→search round-trip (semantic match, zero shared keywords, `_score: 1`) survives the downgrade boot.
- **Search prefixes flipped ON by default (#700).** `EMBEDDING_PREFIXES_ENABLED` → `true`, re-baselined through the ratchet #689 established. Recall numbers are the same A/B as #689 (this flip changes which arm ships by default, not the embedding math either arm computes): p@3 0.976/MRR 0.946 with prefixes on vs. 0.992/0.949 off — a small, previously-measured, noise-scale-at-this-N delta. Flipped on strategic grounds rather than a recall win: nomic-embed-text-v1.5 is trained expecting `search_document:`/`search_query:` prefixes (running unprefixed was the actual departure from convention), and this is the first real payload for the boot-keyed auto-migration machinery (see below) to prove itself against, deliberately exercised now rather than left dormant until a higher-stakes future migration needs it first. Every existing row's embedding stamp becomes stale under the new `<model>+searchprefix` id; the always-on `embedding-stamp` migration re-embeds them automatically (see Upgrade notes and the migration-runner section).
- **Recall-harness instrumentation (#701)**, used for a Q8-vs-Q4 GGUF quantization bakeoff (not a shipped default change): `--model-file <path>` override, per-kind MRR reporting, seed-pass latency reporting. Measured Q8_0 vs Q4_K_M: +0.008 p@3, +0.004 MRR, zero per-kind regressions, ~38% faster embed on M4, +62MB disk — informational, no default model changed in this release; this instrument is also what `flair-bench` (below) validates itself against.

### 🔄 Zero-touch auto-migration runner + CI enforcement lanes (flair#695, #690, #692)

Runtime infrastructure for unattended schema/data migrations across an upgrade, plus the CI lanes that prove the safety invariants hold.

- **Boot-keyed migration runner** (`resources/migrations/*`, #690): on boot, `MigrationRegistry` + `runner.ts` detect pending migrations, compute one shared async pre-hash after boot-ready but before any first write, then run a per-migration pre-flight ladder — disk-space check with a 90%-headroom floor → prune old snapshots → take a risk-scoped snapshot → content-only export fallback → halt with an exact reason if none of that clears. Migrations run in throttled batches with per-row progress markers; a risk-class-specific completion gate (derived-only: count+marker; schema-additive: count+full envelope; content-transform: count+old-row-envelope+new-row-presence) gates a post-hash + a structural-only ledger `OrgEvent` + a state-file update + snapshot prune. Single-flight via an in-process mutex plus a stale-tolerant file lock. Designed to never throw out of the boot path — every failure resolves to a halted/failed progress entry.
- **`embedding-stamp` migration** (always-active, derived-only, part of #690): re-embeds any row whose stamp doesn't match the current `getModelId()` output. Regenerates via a genuine admin-authenticated loopback `PUT /Memory/:id` — the same mechanism `flair reembed` already uses in production — rather than a bare in-process `databases.flair.Memory.put()` call, which was found (via the integration test against real Harper) to bypass `resources/Memory.ts`'s subclass entirely. This is the mechanism that automatically re-embeds the corpus after the search-prefix flip above.
- **Version handshake** (`src/version-handshake.ts`, #690): public `GET /Health` now also reports `version`; every CLI command gets a cached (~60s TTL) version check via a global preAction hook (gated on `isTTY`); `flair doctor` shows the version triple plus migration state, with `--fix` offering a restart on mismatch.
- **CI enforcement lanes** (`.github/workflows/migration-ci-lanes.yml`, #692), enforcing the migration-safety invariants tracked at flair#695:
  - **`downgrade-and-revert`** — installs the last published release, seeds a 140-row corpus, swaps in the PR build with test migrations enabled, catches the synthetic migration genuinely mid-flight via a bounded poll, kills Harper, reinstalls the previously-published release against the same partially-migrated store, and asserts it boots and serves the corpus byte-identically.
  - **`snapshot-restore-drill`** — seeds, lets auto-migration run to completion, deliberately corrupts migration-touched rows via a raw ops-API partial update, restores via `flair snapshot create`/`restore`, verifies byte-identical integrity. (Design note surfaced for K&S: the migration runner's own internal pre-flight snapshot is deliberately risk-class-scoped — metadata-only or schema+metadata, never row content — so it isn't itself the content-recovery mechanism this drill exercises; `flair snapshot`/`restore` is.)
  - **`upgrade-smoke` extended**: seeds stub-stamped rows before the version swap and asserts the auto-migration completed, its content-hash envelope matched, and recall parity held post-migration.
  - Shared bounded-retry primitives (`scripts/ci/migration-lane-lib.sh`) back every post-boot/post-restart check in all three lanes — no single-shot probes.

### 🔐 Cloud-agent auth consumer — `client_credentials` + `private_key_jwt` (#663)

Flair's consumer side of headless cloud-agent auth to a Harper MCP endpoint, per RFC 7523: `client_credentials` grant + `private_key_jwt` client assertions over Ed25519 (EdDSA), now proven against the published `@harperfast/oauth@2.2.0` (previously a stub while the upstream contract was unfinalized).

- **Assertion signing** (`signClientAssertion`) — accepted by the plugin's real `verifyClientAssertion` in live-package interop tests, not a mirror implementation.
- **CIMD document build + hosting** (`MCPClientMetadata`) — resolves through the plugin's real, SSRF-guarded `resolveCimdClient`. Negative-tested: `allowedHosts` rejection, and a document leaking private-key material is rejected by the plugin's own validator even bypassing flair's build-time guard.
- **Live token round-trip** (`requestMcpAccessToken`/`getMcpAccessToken`) — real token POST honoring the 2.2.0 rate limiter's two consumer disciplines: token caching (mint once per client/endpoint/resource, reuse until near-expiry) and `429 slow_down` handling that respects `Retry-After` with full-jitter backoff (exponential fallback when the header is absent). `flair mcp token` now actually mints (`--dry-run` still available for inspect-only).
- Proof: 41 unit tests (including a post-auth-debit isolation proof — five forged assertions against a capacity-1 rate-limit bucket never drain it, the legitimate client still mints) plus 5 integration tests against a real ephemeral Harper with `@harperfast/oauth@2.2.0` mounted as a genuine component.
- **Known boundary, by design**: 2.2.0's CIMD fetcher unconditionally refuses loopback/private hosts, so the full over-the-network CIMD-fetch-to-200-mint path cannot be exercised against a local Harper at all — deferred to a follow-up run against a real public-HTTPS host. Consuming the minted token in an actual MCP client session (`Authorization: Bearer` against `/mcp`) is also out of scope for this PR.

### 📊 `flair-bench` — standalone `npx` embedding benchmark (#702, #703, #705)

New workspace package **`@tpsdev-ai/flair-bench`** — an `npx`-runnable recall benchmark for any GGUF embedding model, with no flair install required.

- **Commands**: `flair-bench run --model-file <a.gguf> [--model-file <b.gguf> …] [--label <str>]`, `flair-bench recommend`, and `--share` to write a redacted, locally-saved result file (the hosted submission endpoint is a documented placeholder — no network call is made anywhere in this package as shipped).
- **`--label`** is a freeform user-chosen infra tag (never auto-filled from the real hostname) — intended to let a set of shared results build a model × infra comparison matrix, not just a model comparison.
- **Corpus and scorer are kept honest against drift**: the corpus is a build-time copy of the internal recall-harness's corpus, synced via a script and deep-equal-checked against the live source on every root `bun test` run; the scorer is a faithful hand-replication of the harness's scoring function, guarded by a source-text tripwire test that fails if the harness's formula changes shape.
- **Share schema is redacted by design** — no hostname, filesystem path, or username in the document; `model.fileBasename` is a basename only. Gated by a dedicated schema test.
- **Recommend heuristic is a documented, simple fixed-threshold rule** (best MRR among models whose peak-RSS delta fits within 50% of available RAM and whose ms/embed is ≤500ms) — explicitly not learned or host-class-aware, and the README documents a real limitation this validation run surfaced: `os.freemem()` under-reports available RAM on macOS relative to what's actually usable.
- Validated against the same v2 corpus/`BASELINE.json` the internal recall-harness uses: p@3 matched exactly (0.976); MRR differences were small (+0.002 to +0.004) except for one flagged outlier (`nomic-embed-text-v2-moe`, ΔMRR −0.029 despite matching p@3) attributed to exact-cosine-vs-HNSW/BM25-fusion scoring differences, called out honestly as a hypothesis rather than resolved.
- #703 (same day) adds a README Features entry pointing at the package. #705 discovered flair-bench had been **left out of both release mechanisms entirely** (`scripts/release.sh` and `.github/workflows/release-publish.yml` both hardcode their package lists, and neither had been updated when flair-bench was added) — confirmed via `npm view @tpsdev-ai/flair-bench` returning 404 — and fixed both lists, plus discovered and fixed a missing `LICENSE` file that would have silently dropped out of every tarball. **flair-bench is still not live on the npm registry as of this release** — `npm stage publish` requires the package to already exist, so a maintainer with npm org-owner access must do a one-time manual `npm publish` + Trusted Publisher registration before it starts flowing through the normal tag-triggered release pipeline; #705's fix isolates flair-bench's stage-publish step with `continue-on-error: true` specifically so this doesn't block the other 7 packages' releases in the meantime.

### 💓 Presence: liveness beacon instead of a sticky status board (#657)

Fixes a real bug verified live on an adopter install: an agent offline for 13 days still showed `activity: "debugging"` on the public roster — `presenceStatus` correctly went offline, but `activity`/`currentTask` were frozen at their last-set value forever.

- **New additive field** `Presence.activityUpdatedAt: BigInt` — when activity/task were last actually asserted (absent on pre-existing records; readers fall back to `lastHeartbeatAt`).
- **Read model changes**: a fresh presence reports current activity/task as before. A stale one (heartbeat past the existing offline threshold, or the activity stamp itself lapsed) now decays `activity` to `"idle"` and `currentTask` to `null`; the last-known label moves to a new public `lastActivity` field plus `activityAgeMs`/`activityFresh`, so a client can render "offline (was: debugging)" without re-deriving staleness itself.
- **Heartbeats self-decay**: `activityUpdatedAt` is only re-stamped on a beat that actually asserts activity/task; a pure liveness beat (no activity change) preserves the prior stamp, so activity decays naturally once an agent stops updating it. `POST /Presence`'s wire contract is unchanged.
- `currentTask`'s existing verified-reader gate (flair#592-class) is unchanged — this does not widen who can see it, only how stale content is presented.
- **⚠ Flagged consumer behavior change in the PR itself**: an offline/stale agent now reports `activity: "idle"`/`currentTask: null` instead of the frozen last value — any downstream consumer (the PR names the Office Space dashboard specifically) reading `activity` directly instead of `lastActivity` will see a behavior change on upgrade.

### 🎯 `compositeScore` relevance-gate hardening (flair#623 follow-up, #661, #662)

Follow-up to the flair#623 default-to-raw flip already in this Unreleased batch. A harder 87-record synthetic corpus added to the recall-harness (#661) reproduced the original compositeScore bug in isolation at Δp@3 −0.900 (far worse than the −0.38 to −0.50 measured live): `compositeScore`'s durability-weight × recency-decay multiplier applied completely unconditionally, with no relevance floor at all (unlike `retrievalBoost`'s existing floor gate), so an unrelated-but-`permanent`/fresh record could rack up zero discount at all and outrank the objectively correct match.

- **First attempt, documented as a dead end in the code (not reintroduced)**: ramping the discount open as `rawScore` rises, mirroring `retrievalBoost`'s gate shape. Measured *worse* (p@3 0.033 vs the original bug's 0.067) — on this corpus a genuine match already has a high raw score, so ramping-by-relevance applies the discount hardest to exactly the records most needing protection.
- **The actual fix**: bound `dWeight × rFactor` to a small band around 1.0 via `COMPOSITE_DISCOUNT_FLOOR` (default 0.98, max −2%, tuned empirically to fully close the recall-harness gap to raw on both p@3 and MRR across 3 runs), gated by `COMPOSITE_RELEVANCE_FLOOR` (default 0.5, same value as `retrievalBoost`'s floor) so records below the relevance bar get no adjustment at all. Both are env-overridable (`FLAIR_COMPOSITE_DISCOUNT_FLOOR`, `FLAIR_COMPOSITE_RELEVANCE_FLOOR`).
- **`scoring: "composite"` remains off by default** — this hardens the mechanism for the (still-manual) opt-in path; it does not itself flip the default. (The later usage-feedback signal work in this same Unreleased batch, flair#683/#684, separately replaces `compositeScore`'s reinforcement term but keeps composite off by default for the same reason.)

### 🔗 Ergonomic relationship-write surface — `relationship_store` MCP tool, `flair relationship add`, `RelationshipApi`

A full auth-gated `Relationship` resource (subject/predicate/object triples with temporal validity) already existed, but there was no ergonomic, agent-directed way to write one — no MCP tool, no CLI command, no typed client helper. An agent couldn't *say* "record that X manages Y"; the graph the attention read (`MemoryBootstrap.ts`) queries stayed near-empty. This adds the write surface, mirroring the established `memory_store` shape at every layer, plus folds in auth/dedup/provenance hardening to the existing resource:

- **`RelationshipApi`** (`packages/flair-client`): `client.relationship.write({subject, predicate, object, confidence?, validFrom?, validTo?, source?})` → `PUT /Relationship/<canonical-id>`. Built first — the MCP tool and CLI command are thin wrappers over it.
- **MCP tool `relationship_store`** (`packages/flair-mcp`): mirrors `memory_store`'s shape (zod schema, `content[]` + `structuredContent`). Description spells out the triple model, the assert/upsert semantics, a recommended soft predicate vocabulary (manages, works_on, reviews, depends_on, replaces, owns, reports_to, advises — free text, no server enum), and the contradict-a-prior-relationship workflow (re-assert with a `validTo` or delete, then write the new one — a different predicate does NOT auto-close the old triple).
- **CLI `flair relationship add`** (`--agent` required, Ed25519-signed via the existing `api()` helper — mirrors `flair memory add`).
- **Canonical, per-owner, deterministic id** (dedup): `base64url(SHA-256(lowercased agentId+subject+predicate+object)[:16 bytes])`. Re-asserting the identical triple upserts the same row (mutable fields — confidence/validFrom/validTo/source — update; id and identity stay stable) instead of creating a duplicate row, via Harper's ordinary PUT-by-primary-key (no pre-insert query, no race). A real SHA-256 (`crypto.createHash`), not a weak/platform-specific hash; fields are NUL-joined before hashing so free-text subject/predicate/object can't collide across a field boundary shift. `agentId` is folded into the hash, so the same triple asserted by two different agents lands at two different ids (per-owner, no cross-agent collision).
- **Auth reconcile**: `Relationship.put()` AND `.delete()` upgraded from the older `request.tpsAgent`-direct pattern to `resolveAgentAuth()` (matching `Memory.post()`/`Memory.put()`) — anonymous denied (401), a non-admin agent's `agentId` always comes from the verified signature (never the request body; a mismatched body `agentId` is rejected with 403 rather than silently overwritten), admin/internal calls remain unfiltered (no regression to existing internal callers).
- **Provenance parity**: `Relationship` gains a nullable `provenance` field, stamped via the SAME `buildProvenance()` helper `Memory` uses (now extracted to `resources/provenance.ts` so both tables share one implementation) — identical `{v, verified:{agentId,timestamp}, claimed?:{model}}` shape, no relationship-specific format. Additive/nullable; a pre-existing row with no `provenance` field still reads back fine (migration-equivalence, same discipline as the earlier `usageCount` addition).
- **Scope unchanged**: this stays owner-scoped exactly as today — relationship reads are NOT made open-within-org here. That's a deliberate, separate follow-on decision (gated on the same federation-edge hardening as any future Memory read-scope change), not a default.
- Covered by round-trip (write → surfaces in bootstrap for a predicted subject, proving lowercasing + the read contract), dedup (same triple twice → one row; a different confidence upserts; a different predicate is a separate row), auth (anonymous 401; a caller cannot claim another agent's `agentId`), provenance (`verified.agentId` present; a pre-provenance row reads null without error), and a render-safety check on the attention read's `subject → predicate → object` line — all against a real spawned Harper instance, plus unit coverage for the canonical-id algorithm and a CLI/flair-client cross-check guarding against the two implementations drifting apart.

### ⚡ Bootstrap scale fix — bounded queries replace the org-wide memory scan

`MemoryBootstrap.post()` loaded the entire org's non-private Memory corpus into RAM on every bootstrap call (an unbounded `Memory.search()` — no `limit`/`select`, every row's full 768-float embedding vector included) then ran a hand-rolled O(N·d) JS dot-product scan over all of it. Both scaled with the size of the whole org's memory corpus, not the caller's own — a liability on a hot, every-session path that got worse as collision surfacing (flair#681) and open-within-org reads (flair#578) widened the scanned set.

- **Extracted a pure retrieval core** (`resources/semantic-retrieval-core.ts`, `retrieveCandidates()`) from `SemanticSearch.post()` — the HNSW/BM25 retrieval + all post-retrieval filtering (temporal/expiry/supersede exclusion, the `scope.isAllowed()` defense-in-depth re-check), taking primitives only, never a Resource instance. Auth, rate-limiting, the reranker, and the `retrievalCount`/`lastRetrieved` hit-tracking side effects stay in `SemanticSearch.post()`'s wrapper, so bootstrap's internal call never trips them. `SemanticSearch`'s own behavior is unchanged (full unit-test suite green; the isolated recall-harness returns byte-identical p@3/MRR before and after).
- **Own-scoped pushdowns** for the permanent/recent/predicted lifecycle slices: `Memory.search` calls conditioned on `agentId==self` (+ durability/createdAt, all `@indexed`), explicit `select` (no raw embedding) — replacing the post-load JS filter over the full org corpus.
- **Bounded HNSW candidate pool** for task-relevant/teammate/collision surfaces via the same `retrieveCandidates()` core — HNSW-leg pushdown only (no BM25 fusion, no reranker; a different, likely-worse cost profile for a one-shot session load — opt-in follow-on), sized `K = max(3 × expected fill, 5 × teammate count, 50)`, capped at 100.
- Per-set supersede exclusion (own slices independently, candidate pool independently) — the unconditional past-`validTo` guard (the primary supersede defense) is preserved verbatim.
- `memoriesAvailable` is now an own-scoped count (`agentId==self`, a cheap indexed seek) instead of the org-wide exact figure — computing that exactly was itself the scan being removed.

No scope widening: own-scoped queries are strictly narrower than the previous load-then-filter; the candidate pool carries the identical `scope.condition` (own OR non-private). Measured on a synthetic 6,100-record corpus (6,000 org-wide + 100 own) against an ephemeral Harper instance: bootstrap latency dropped from 350ms (cold) / 309ms (warm mean) to 91ms / 48ms.

### 🎯 Usage-feedback signal — `usageCount` + `usageBoost` replaces `retrievalBoost` (flair#683)

flair#623 found `compositeScore` measurably losing to raw relevance and flipped the default to `raw`. The root cause was the *signal*, not the model: the reinforcement term was `retrievalCount` — incremented on every search hit (`resources/SemanticSearch.ts`) — so a doc surfacing once got boosted, surfaced more, boosted more, independent of whether it was ever actually useful. This ships a stronger, distinct signal: verified *use*, captured explicitly.

- **Schema:** `Memory.usageCount: Int` (additive/nullable, absent = 0). Never auto-incremented on search — the *only* writer is the new endpoint below.
- **`POST /RecordUsage` + MCP tool `record_usage`** (`resources/RecordUsage.ts`): report that memory id(s) were actually cited/used, with an optional opaque `attribution` string. A **dedicated** endpoint, not `Memory.put()` — usage feedback is a cross-agent write (agent B reports using agent A's memory) that `Memory.put()`'s ownership check would 403; this does a targeted `usageCount`-only bump instead, so no other field on the target memory can change. Verified-agent auth, no ownership requirement. Anti-gaming (three layers): a `~30 RPM` rate-limit bucket, a dedup ledger (`MemoryUsage` table, `resources/MemoryUsage.ts`) capping each (agent, memory) pair at ≤1 contribution, and the capped/floor-gated boost itself. Responses are **identical** for a not-found id, an already-counted id, and a fresh valid id — no ID enumeration.
- **Scoring:** `usageBoost()` (`resources/scoring.ts`) — the exact same gentle, capped, floor-gated shape as `retrievalBoost` (`min(1.0 + 0.1·log2(n), 1.1)`, floor 0.5). `compositeScore` now uses `usageBoost(usageCount)` **in place of** `retrievalBoost(retrievalCount)` — dropped outright, not just outweighed, since the old signal was contaminated by construction (a search hit ≠ verified use). `retrievalCount`/`retrievalBoost` remain exported (a future weak-prior idea, not built here) but are no longer read by `compositeScore`.
- **Harness rematch** (`test/bench/recall-harness/run.ts --usage-rematch`): a usage-injection path measuring composite-vs-raw under three regimes on the existing 87-record/30-query corpus — POSITIVE (usage on ground-truth-relevant docs: composite **beats** raw, p@3 +0.033/MRR +0.042), NEGATIVE CONTROL (usage on whatever merely surfaces, the `retrievalCount` shape: composite **reproduces** the #623 loss, p@3 -0.200/MRR -0.155 — proving the fix is about signal quality, not the boost mechanism), and a NOISE SWEEP (ground truth + random non-ground-truth usage at 0–4× ratios: composite-with-usage held ≥ raw across the full tested range on this corpus).
- **Composite stays OFF BY DEFAULT** (raw remains the default, unchanged since #623). This ships the mechanism + the simulated-usage rematch; the real-world default-flip decision needs usage accrued from live dogfooding of `/RecordUsage`, re-measured with `recall-eval.mjs` on the live corpus.

### 🏢 Collision surfacing in bootstrap — "Others in the room" (flair#681)

The attention plane's flagship (design: `FLAIR-ATTENTION-PLANE.md` "Phase 2"). `MemoryBootstrap.ts` now surfaces a short, ranked "## Others in the room" block — teammates whose active work collides with the caller's, e.g. `Anvil is touching issue:tpsdev-ai/flair#504 (implementing embeddings) — last active 4m ago`. Two independently-scoped surfaces are joined, never conflated: **Memory is the semantic surface**, reusing flair#550's existing scored-Memory path as-is (the caller's `currentTask` embedding, dot-product against in-org Memory, the SAME `score > 0.3` relevance floor — no new embedding code anywhere in this feature); **WorkspaceState/OrgEvent are the entity surface** (exact vocabulary-string overlap against the caller's own declared `entities` — a new optional `entities` field on the `MemoryBootstrap` request, falling back to the caller's own most-recent `WorkspaceState.entities` when omitted). Both surfaces are freshness-gated on `Presence` (a teammate absent from the roster, or `presenceStatus: "offline"`, never surfaces regardless of match strength); when both surfaces match the same teammate, the entity match wins (higher precision). WorkspaceState/OrgEvent reads run the SAME internal server-side path flair#678's `AttentionQuery` established (Sherlock Option 1 — the raw table object, never the exported `WorkspaceState` resource class, which would just re-apply per-agent 403 scoping to the caller's own identity) — this does **not** broaden `WorkspaceState`'s general read model; a direct cross-agent `GET`/`search()` still 403/404s, verified end-to-end against a real spawned Harper. The Presence roster fetch (the synthetic delegation-context trick that preserves `Presence.get()`'s verified-agent `currentTask` content gate, #592) is now a shared helper (`resources/presence-internal.ts`), extracted from `AttentionQuery.ts` so the pattern has exactly one implementation — `AttentionQuery.ts`'s own behavior is unchanged (same tests, same assertions). New pure join/rank/format module `resources/collision-lib.ts` (Harper-free, unit-tested directly) also fixed a real bug caught only by e2e testing against a real spawned Harper: a single-entity OR-condition (`{operator: "or", conditions: [...]}` with exactly one clause) throws in Harper's real query engine ("An 'or' operator requires at least two conditions") — silently swallowed by the collision block's best-effort try/catch, so a caller declaring exactly one entity (the common case) would have produced zero results with no visible error. `buildEntityMatchCondition()` special-cases the single-entity form. Covered by `test/unit/collision-lib.test.ts` (join/rank/freshness-gate logic) and `test/integration/bootstrap-collision-e2e.test.ts` (real Harper, real embeddings — entity overlap, non-overlap exclusion, the freshness gate against a genuinely stale Presence row, semantic-only surfacing, the metadata-leak/cross-agent-boundary probes).

### 🐛 `flair workspace set` sent a bare POST that 405s against real Harper (flair#679)

Surfaced by the attention-query e2e testing (#677/#678), measured against a real spawned Harper: `flair workspace set` sent a bare `POST /WorkspaceState` (no id in the URL). `WorkspaceState.post()` (`resources/WorkspaceState.ts`) delegates to `super.post()` — the Harper-generated table class's own post handler — which 405s a collection POST ("does not have a post method implemented to handle HTTP method POST"), the same restriction `resources/Memory.ts` documents and `soul set` was already fixed for (#498). Table writes over real HTTP require `PUT /<Table>/<id>`. `flair workspace set` now signs and sends `PUT /WorkspaceState/{agentId}:{ref}`, including `agentId`/`createdAt` in the body (`WorkspaceState.put()`, unlike `post()`, doesn't auto-attribute or default these — it 403s a mismatched `agentId` rather than overwriting it, so this is a self-declaration the server verifies against the Ed25519 signature, not a forgeable claim).

`flair orgevent`'s bare `POST /OrgEvent` does **not** actually 405 today (measured directly, `test/integration/workspace-orgevent-cli-e2e.test.ts`) — `OrgEvent.post()` bypasses `super.post()` and calls `databases.flair.OrgEvent.put()` directly, so it's reachable over real HTTP. It's switched to `PUT /OrgEvent/{id}` anyway, for consistency with every other table resource and so a future refactor that made `OrgEvent.post()` delegate to `super.post()` (mirroring `WorkspaceState.post()`) can't silently reintroduce this exact 405. The id is now client-generated (`${agentId}-${randomUUID()}`, mirroring `flair-client`'s `Memory.write()` convention) rather than relying on `post()`'s own `${authorId}-${isoTimestamp}` default, which risked same-millisecond collisions.

Both commands are covered end-to-end against a real spawned Harper (`test/integration/workspace-orgevent-cli-e2e.test.ts`): the CLI subprocess writes, and the row is read back over real HTTP to confirm it landed — not just that the CLI exited 0.

### 🔭 Attention-plane query — "what's touching entity E in the last N days?" (flair#677)

The Phase 1 query from `FLAIR-ATTENTION-PLANE.md`, built on the entity vocabulary + `entities[]` fields from flair#675/#676. New `POST /AttentionQuery` (`resources/AttentionQuery.ts`), CLI (`flair attention <entity> [--days N]`, default 7d), and MCP tool (`attention`, `resources/mcp-tools.ts`) return a unified, grouped-by-source, recency-ranked view across Memory, Relationship, WorkspaceState, Presence, and OrgEvent for one validated vocabulary string. Read-only, exact-match index pushdown — no scans, no collision surfacing (that's a separate follow-up). Per-source read-scoping is strictly respected: Memory goes through the centralized `resolveReadScope()` (open-within-org, minus private); Relationship mirrors its own existing per-agent scoping; OrgEvent rides its already-org-open read model; Presence goes through the `Presence` resource's `get()` so its verified-agent `currentTask` content gate (#592) is preserved, never the raw table. WorkspaceState is the one deliberate exception (Sherlock's K&S-approved Option 1): normally strict per-agent (403 cross-agent), it's queried via the raw table object as a narrow, server-computed join scoped to one validated entity + a bounded day window — never a general broadening of `WorkspaceState`'s read model (direct `GET /WorkspaceState` cross-agent access is unchanged). Malformed entity strings 400 via the existing `entity-vocab.ts` validator.

### 🔭 Attention-plane foundation — entity vocabulary + `entities[]` fields (flair#675)

Foundation slice of the attention plane (design: `FLAIR-ATTENTION-PLANE.md`, K&S-approved). New `resources/entity-vocab.ts` documents and enforces the entity vocabulary convention — namespaced `type:value` strings, lowercased type, from a closed set (`repo:<owner>/<name>`, `issue:<repo>#<n>`, `customer:<slug>`, `subsystem:<slug>`, `agent:<id>`, `person:<id>`); matching is exact on the full string, no prefix/regex. `entities: [String] @indexed` is now an additive/nullable field on `WorkspaceState`, `OrgEvent`, and `Memory` (added in v1, not deferred to v2, per Kern's review — gives the future attention query uniform index pushdown across all three instead of a partial one); existing rows carry no `entities`, readers tolerate absence, same pattern as `Presence.activityUpdatedAt`. `WorkspaceState.ts`/`OrgEvent.ts`/`Memory.ts` validate `entities` on write via the new `invalidEntitiesResponse()` helper (400 on malformed values). `Relationship` gets no schema change — its `subject`/`object` are already the vocabulary carrier (validating them against this convention is a follow-up). Full writeup in `docs/entity-vocabulary.md`. This slice is vocabulary + fields + validator ONLY — the attention query (`flair attention <entity>`) and bootstrap collision surfacing are separate, later slices.

### 🧰 Tooling / CI

- **CI now matrices Node 22/24/26 instead of testing on Node 22 alone (#672)** — `engines.node` is `>=22` with no upper bound, but every CI job pinned exactly one Node version, so a currently-maintained major could reach production without CI ever having run against it. `test-unit` and `typecheck` (`.github/workflows/test.yml`) now run a `strategy.matrix.node-version: ["22", "24", "26"]` (`fail-fast: false`, so one version's failure doesn't hide the others); a `test-unit-gate`/`typecheck-gate` job re-emits the fixed `Unit Tests`/`Type Check` check names branch protection expects, since GitHub Actions suffixes matrixed job names/contexts with the matrix value. `pack-smoke` (install-from-tarball smoke) also matrices 22/24/26 — it's the job that spawns the packed CLI directly under `node`, the most representative "does a real user's Node actually work" path. `test-integration` stays pinned to Node 22 (its existing HarperFast/harper#386 native-spawn-vs-Docker mitigation is version-load-bearing) and `upgrade-smoke` moves from 22 to 26 (Current) as a single-version pin — its invariant is cross-version data survival, not Node-runtime behavior, so matrixing it would 3x an already-heavy job for no extra signal. Currently-maintained set as of 2026-07: 22 = Maintenance LTS, 24 = Active LTS, 26 = Current (25 reached EOL 2026-06-01 when 26 shipped, excluded).

- **`upgrade-smoke` now runs the real upgrade path on every PR, not just version-bump PRs (flair#620, #664).** The job always executed, but an internal version-string comparison (`BASELINE == HEAD_VERSION`, true on the vast majority of ordinary feature PRs that don't bump `package.json`) short-circuited the actual install→seed→upgrade→verify sequence to a trivial pass. Removed the short-circuit — HEAD is now always packed from the PR's real tree regardless of its version string, so the highest-blast-radius failure mode (upgrade data loss/corruption) gets tested on every PR instead of at release cadence.
- **CI docs-freshness gate (flair#618, #658).** New `node scripts/docs-freshness-check.mjs` gate, runnable locally, zero new deps: fails independently on a stale version-pin in install commands, a hardcoded (non-placeholder) version in quickstart, a retired-port reference presented as current, a non-`@tpsdev-ai`-scoped package name, an emptied `[Unreleased]` section while feat/fix commits exist since the last tag, or any CLI command/subcommand with a blank `.description()` (walked from the real built `dist/cli.js` command tree). Found and fixed real remaining rot on introduction: `soul set`/`get`/`list` had shipped with blank descriptions.
- **Strict typecheck extended to `src/**` (flair#643, #669).** `tsconfig.check.json` previously only covered `resources/**`; the CLI, probe, fleet-verify, deploy, and bridges modules under `src/` had zero strict-mode coverage in CI beyond the non-strict `build:cli` compile. New `tsconfig.check.src.json` (strict, excludes only `src/cli.ts` pending a later split, and the naturally-out-of-scope `src/cli-shim.cts`) wired into the existing `typecheck-strict` job. All 37 covered files were already strict-clean — no source changes needed to land the gate.
- **Harper Docker image tag now derived from `package.json` (flair#625, #656)** instead of a separately-maintained literal, closing a version-drift class between the declared and materialized Harper Docker version.

### 🧹 Removed vestigial legacy observatory ingestion surface (flair#628)

Deleted the March-2026 prototype observatory surface (`resources/IngestEvents.ts`, `ObsOffice.ts`, `ObsAgentSnapshot.ts`, `ObsEventFeed.ts`, `ObservationCenter.ts`, `src/observatory-sync.ts`, `ui/observation-center.html`, the three `Obs*` tables in `schemas/schema.graphql`, and their dedicated tests) alongside its allow-list/role wiring (`auth-middleware.ts`'s `/ObservationCenter` public early-return, `cli.ts`'s `ObsOffice`/`ObsAgentSnapshot`/`ObsEventFeed` role grants). Also drops the now-obsolete `ui/` package entry (`package.json`'s `files`, `src/deploy.ts`'s `REQUIRED_PACKAGE_FILES`) — `ui/observation-center.html` was the sole `ui/` file, so its removal emptied the directory. The surface was unused in this repo — no code path produces a request to Flair's own `/IngestEvents`, and production observability now runs on the standalone `tpsdev-ai/observatory` app — so this removes dead attack surface (`IngestEvents`' signature check only covered replay via a timestamp window, no nonce store) rather than changing any live behavior.

### 🕵️ Presence gains a `debugging` activity (flair#613)

The activity enum (`coding`/`reviewing`/`planning`/`idle`) had no value for the flagship collision-detection use case: a live incident/production investigation. Agents fell back to `--activity reviewing`, misrepresenting what they were doing on the public roster. `debugging` is now a valid `flair presence set --activity` value end-to-end — CLI validation (`src/cli.ts`), the `/Presence` resource's server-side validation (`resources/Presence.ts`), the `PresenceActivity` type (`packages/flair-mcp/src/presence.ts`), and the schema doc comment (`schemas/schema.graphql`). Auto-presence's `deriveActivity()` (flair#608) also gains a matching surface-name mapping — `debug`/`investigat`/`incident` in the surface string now derives `debugging` instead of falling through to `coding`.

### 🎯 `SemanticSearch` scoring default flipped from `composite` to `raw` (flair#623)

Measured 2026-07-08 with `recall-eval.mjs` against the live corpus (BM25 hybrid active): `scoring: "composite"` (the previous default) is net-HARMFUL — Δp@3 (composite − raw) = **-0.38 to -0.50** across repeated runs (raw held steady at p@3=0.50/MRR=0.438; composite ran 0.13→0.00 p@3 / 0.073→0.056 MRR as reruns fed retrievalCount's rich-get-richer loop). Root cause: `compositeScore`'s durability-weight × recency-decay multiplier (`resources/scoring.ts`) applies unconditionally — no relevance gate, unlike `retrievalBoost`'s existing `RBOOST_RELEVANCE_FLOOR` — so a `permanent`-durability or freshly-created but weakly-matching record routinely outranks the objectively best semantic/BM25 match. This was a smaller effect before BM25+RRF fusion normalized raw scores into a tight band; now the ±10-30% durability/recency multiplier is often larger than the real relevance gap between candidates, so it dominates ranking instead of nudging it. `scoring: "composite"` is unchanged and still available as an explicit opt-in (`flair search --scoring composite`, or `scoring: "composite"` in the `/SemanticSearch` payload) for callers who want durability/recency-aware re-ranking; it is simply no longer the default. No change to `compositeScore` itself — revert by passing `scoring: "composite"` explicitly, or reverting this commit.

### 🔎 BM25 + union-RRF hybrid retrieval — ACTIVATED (follow-up to #519)

`FLAIR_HYBRID_RETRIEVAL` now defaults **ON** (was default-OFF since #519 shipped the feature). Recall-eval at build time validated the intended gain: the NEW-8 within-cluster gate held p@3=0.88 (no regression); the OLD-6 severe near-verbatim misses recovered 0/6 → 4/6 into top-10 (1/6 into top-3). A fresh isolated-Harper measurement at activation time (ephemeral spawned instance, zero production contact) confirmed zero regression on a synthetic severe-miss/within-cluster-gate corpus and a small latency delta (~+4ms/query, ~27ms absolute at n≈90 records). Revert lever unchanged: set `FLAIR_HYBRID_RETRIEVAL=false` (also `"0"`/`"off"`) to fall back to the byte-identical legacy HNSW + keyword-bump path — no code rollback needed.

- **Fixed a blocking regression found during activation testing:** the hybrid path's candidate-union RRF fusion silently returned **zero results** for a `SemanticSearch` call with neither `q` nor `queryEmbedding` — the "list everything in my scope" shape (`agentId`/`tag`/`subject`-only calls; see `test/integration/memory-visibility-scoping-e2e.test.ts`), which the legacy path answers with a full scoped listing. `resources/SemanticSearch.ts`'s hybrid branch now falls back to emitting the already-security-filtered `allowedById` candidate set directly at `rawScore 0` when neither retrieval signal is present, matching the legacy contract exactly. Regression-guarded by `test/integration/bm25-hybrid-noquery-listing.test.ts`.

The upgrade path becomes one tested transaction — install, restart, verify, and roll back automatically on failure — backed by a pre-upgrade data snapshot, a nightly-checked downgrade path, and a post-deploy fleet-convergence sweep. Also closes out the remaining `authorizeLocal`-class security gaps from the 0.21.0 state review.

### 🔁 `flair upgrade` restarts by default, verifies, and rolls back (#635, #641)

Upgrade is now one transaction: install → restart → verify → rollback-on-failure, instead of leaving the OLD process serving while the version on disk lied about what was actually running. Restart-after-install is the new default (`--no-restart` opts out; the old `--restart` flag is a deprecated no-op). After restart, `probeInstance` confirms `/Health`, an authenticated round-trip, and that the reported running version matches what was just installed (`--no-verify` to skip). On verification failure, `flair upgrade` reinstalls the previously-running version, restarts, and re-verifies — and if that rollback also fails to verify, it points at the pre-upgrade snapshot instead of looping.

### 📸 Pre-upgrade data snapshot (opt-in) + `flair snapshot` command + tested downgrade path (#637, #647)

`flair upgrade --snapshot` snapshots `~/.flair/data` to `~/.flair/upgrade-snapshots/` (timestamped tar.gz, exact file modes preserved, keep-last-3 retention) before touching any package — quiescing Flair first, since a live RocksDB directory mid-compaction isn't safe to copy. A snapshot failure aborts the upgrade before any package changes. Opt-in, off by default: the default run instead prints a non-blocking recommendation nudge (never prompts/blocks). The same mechanism is now also a standalone `flair snapshot create|list|restore` command — physical, byte-exact, local-only, distinct from the logical JSON `flair backup`/`flair restore`. `docs/upgrade.md` gains a full [Downgrade](docs/upgrade.md#downgrade) procedure, and a nightly compat test (`test/compat/downgrade-boot.test.ts`) actually boots the last npm-published release against newer data and confirms it reads back cleanly — replacing the old "not a tested path" language with an honest, continuously-checked claim.

### 🚦 `flair fleet verify` — post-deploy convergence sweep (#636, #642)

Fabric deploys tolerate replication errors by design (origin-first), but nothing previously confirmed peers actually converged — the 0.21.0 deploy shipped with a peer still throwing 1006s while the CLI reported success. New standalone `flair fleet verify --target <url>` sweeps the origin + every known Flair federation peer, prints a per-node table, and exits 0 (all verified) / 1 (origin failed) / 2 (peer version skew) / 3 (peer unreachable/unverifiable). Wired automatically into `flair deploy` and `flair upgrade --target` post-success (`--no-fleet-verify` to skip). Explicitly scoped to Flair's own federation peers, not Harper's own cluster-replication nodes (`cluster_status` is harper-pro-only and unavailable to this build).

### 🔑 CLI sends real local credentials instead of riding `authorizeLocal` (#634, #640)

`api()` previously sent no `Authorization` header for local targets, relying on Harper's `authorizeLocal` to forge a `super_user` for credential-less loopback requests — a gap the #632 security fix below closed, which meant credential-less local calls like `flair federation status` started getting a real 403. Fixed: local targets now resolve real credentials in precedence order `FLAIR_TOKEN` > `FLAIR_ADMIN_PASS`/`HDB_ADMIN_PASSWORD` > agent Ed25519 key > the `~/.flair/admin-pass` file `flair init` writes. A 403 with no credentials now throws a clear, actionable message instead of a raw "forbidden" body.

### 🛰️ Version-stamped presence + fleet staleness in `doctor` (#639, #645)

`POST /Presence` now stamps the serving instance's running `flairVersion` + `harperVersion` on every heartbeat, gated behind the same verified-agent read as `currentTask`. `flair doctor` gets a new "Fleet presence" section listing known instances oldest-version-first and flagging any behind the newest version seen across the roster (org-relative, not npm-latest). Note: Presence doesn't currently participate in federation sync, so on a hub+spokes deployment this only reports the querying instance's own directly-heartbeating agents.

### 🧪 Mixed-version federation compat CI (#638, #644)

A nightly + PR-triggered suite spawns the last published `@tpsdev-ai/flair` alongside the current build as two independent Harper instances, pairs them reciprocally, and drives a real federation round-trip through each side's own CLI. Surfaced two orthogonal version-skew findings along the way (documented inline, not fixed there): the published baseline predates #634's local-credential fix and predates the `authorizeLocal`-forged-`super_user` hardening on `/FederationInstance`.

### 🔒 Security

- **`authorizeLocal` now defaults to `false` — closes unauthenticated loopback admin on the Harper ops API (#654)** — a credential-less loopback POST to :9925 (`system_information`, `insert`, `add_user`, ...) was auto-authorized as `super_user` (Harper's `authorizeLocal: true`, `config.yaml`). Flair's own application-layer resources were already immune to this forgery (#655's credential-evidence gate), but the raw ops API sat below that layer — any local process, co-tenant, or loopback-SSRF on the host could run unauthenticated admin operations directly against Harper. Not remotely exploitable (remote always required real auth), but a real defense-in-depth hole. All four ops-API seed call sites (`seedAgentViaOpsApi`, `seedFederationInstanceViaOpsApi`, `agent add`, `principal add`) already pass a real admin credential over Basic auth, so this changes no functional behavior for `flair init` / `agent add` / `principal add`. **The admin credential is now load-bearing for local ops** — `~/.flair/admin-pass` (written by `flair init`), `--admin-pass`, or `FLAIR_ADMIN_PASS` — a missing credential now fails closed instead of riding the ambient `authorizeLocal` super_user forgery. A new CI hard gate (`pack-smoke` in `.github/workflows/test.yml`) proves the bootstrap-ordering invariant this required: on a fresh `flair init`, the admin credential exists before any seed call fires, a credential-less loopback ops-API call is rejected, and both the agent seed and the federation-instance seed still succeed via genuine Basic admin auth. Does not affect remote/Fabric admin — `authorizeLocal` only ever governed loopback, and remote has always required real credentials. Set `authorizeLocal: true` in `config.yaml` to restore the old (insecure) behavior for local development only.
- **Gate `FederationInstance`/`FederationPeers`/`HealthDetail`/`SkillScan` — `authorizeLocal` class (#632, closes #631)** — the #614/#630 CI backstop surfaced four resources with no explicit allow-decision, falling through to Harper's default `super_user` check, satisfiable by `authorizeLocal`'s forged loopback super_user. `FederationInstance`/`FederationPeers` now require admin; `HealthDetail` requires a verified caller (and fixes a backwards `isAdmin` default that treated an unresolved caller as admin); `SkillScan` requires a verified caller.

- **Fabric deploy/upgrade credential flags no longer recommend leaking secrets to shell history (#650).** `flair upgrade --target`, `flair deploy`, and `flair fleet verify` docs and examples led with `--fabric-user <admin> --fabric-password <pass>` — both the admin username and password land in shell history and are visible to any local `ps` observer for the process lifetime. New `--fabric-password-file <path>` (mode-0600 file, reuses the existing `--admin-pass-file` secure reader, refuses group/other-readable files) is now the recommended path; inline `--fabric-user` now warns (parity with the pre-existing inline-`--fabric-password` warning). Precedence: inline `--fabric-password` (warned) > `--fabric-password-file` > `FABRIC_PASSWORD` env. Docs (`deployment.md`, `upgrade.md`) flipped to lead with `FABRIC_USER=… FABRIC_PASSWORD=… flair …`, inline flags demoted to a labeled discouraged fallback. No credential value is logged anywhere in the warning/error path. Prompted by a real observation that the docs were recommending the leaky form by default, not a live incident.

### 🧹 Tooling / CI / hygiene

- **Assert every Resource declares an explicit allow-decision (#630, closes #614)** — a repo-wide backstop that enumerates every `resources/*.ts` and fails when a new one ships with no allow-decision; found the four gaps closed by #632 above.
- **Wire the remaining 5 packages' tests into CI (#633, closes #619)** — `flair-client`, `langgraph-flair`, `n8n-nodes-flair`, `openclaw-flair`, `pi-flair` had real test suites CI only typechecked, never ran.
- **Fix port drift + stale security-model docs + `upgrade.md` (#629)** — standardized docs on the real `19926` default, corrected security-model docs still describing the retired grant-gated read model, unfroze `upgrade.md` from a pinned old version.
- **Name the real storage engine — Harper 5.x is RocksDB, not LMDB (#648)** — corrects the #647 snapshot-consistency rationale, which cited the wrong engine (LMDB is what Harper ≤4 used, and remains in the dependency tree, which is where the mislabel came from). The quiesce-before-snapshot design itself is unchanged.
- **Bump `@harperfast/harper` 5.1.15 → 5.1.17 (#607)** — patch bump: replication 503-vs-404 reliability, Docker entrypoint fix, npm-shrinkwrap packaging, MQTT shared-port. No Flair code change needed.

- **Public-repo hygiene sweep (#696, #697).** Comment/doc-only pass (26 files) replacing every reference to private ops spec paths and internal tracker ids with the public tracking issue flair#695 (which now carries the distilled migration-safety invariants + CI-lane rationale). A same-day follow-up (#697) fixed 7 lines the mechanical sweep had garbled — two cases of a path-shaped sentence fragment getting an issue number substituted mid-prose, five citations mechanically re-pointed at the wrong (migration-safety) anchor instead of the correct attention-plane issues (#677, #681) they originally cited. Process fix applied going forward: a mechanical "comments only" sweep now gets a full line-by-line read of the final diff before merge, not just a structural comments-only check — three reviewers had pattern-matched "safe" and missed it.
- **Docs: document the ops-API auth surface split (flair#654, #674).** Docs-only follow-up to the `authorizeLocal` default flip: documents that the Harper ops API now requires admin Basic auth for network requests, while the ops-API **domain socket** (`operations-server`, owner-write-only) remains an inherent local-admin channel that authorizes as `super_user` without credentials, by design — required by the admin-password rotation flow. Explicitly scopes what is and isn't mitigated: any process running as the box owner can still reach the socket; owner-write permissions keep it unreachable by other OS users, co-tenants, or the network.
- **Docs: stale `HARPER_SET_CONFIG`/`models` comment corrections (#686, #668)** — see the native-embeddings section above for #686; #668 is the equivalent same-week correction for `authorizeLocal`-related CLI comments that still described the pre-flip behavior.

## [0.21.0] - 2026-07-07

Federation edge-hardening, open-within-org memory read, an adopter-adoptability sweep (now including automatic MCP presence), and a security closure on Presence/OAuthAuthorize auth-bypass gaps — on harper 5.1.15.

### 🧠 Open-within-org memory read (#578)

Cross-agent read opens up within an org: a verified in-org agent can read another agent's non-private memories (`resolveReadScope` returns non-private OR own), while `private` stays owner-only on every path. Replaces the prior grant-gated model — knowledge is org-readable by default, access-gated only at the federation edge. Live + verified on both rockit and Fabric.

- **Bootstrap teammate-findings aligned to the open model (#606, completes #550)** — the "teammate findings" surfacing already rode on `resolveReadScope()` (never its own `MemoryGrant` traversal), so it picked up #578's behavior with zero code changes needed. Corrected stale comments/nudge copy that still described the retired grant-gated model, and added the missing test proving a `MemoryGrant` is NOT required to see a teammate's memory — every prior test seeded one as harmless leftover from pre-#578 authoring, masking the gap.

### 🔒 Federation edge-hardening (slices 1–4)

Hardens what crosses the federation boundary:
- **Server-stamped verified provenance on writes (#575)** — provenance captured server-side (verified identity + timestamp), not client-claimed.
- **Write-time originator tagging (#576)** — synced tables carry an `originatorInstanceId` stamped at write.
- **Push-side private-visibility filter (#577)** — private memories are filtered before they leave the instance.
- **Per-record signing + verification (#580)** — each synced record is signed over its canonical form and verified on receipt, closing a hub-forgery hole where a relay could forge records for another originator.
- **Persistent anti-replay nonce store (#581)** — the nonce store survives restarts, so replay protection holds across process boundaries.

### 🧰 Adopter adoptability

Making Flair actually work for a fresh adopter instead of silently half-working:
- **`flair doctor` verifies client integration (#599)** — a new "Client integration" section answers "is Flair working for my agent?": per detected MCP client, the MCP block + `FLAIR_URL` reachability + agent registration; for Claude Code, the CLAUDE.md bootstrap line + `SessionStart` hook. `--fix` wires missing pieces (idempotent, merge-safe).
- **`flair doctor` reports not-registered on 401/403, not just 404 (#603, closes #602)** — the auth middleware rejects an unregistered agent's *signed* request before the resource handler runs (401 `unknown_agent`), so the 404-only branch was dead code and a missing agent showed "⚠ couldn't-verify" instead of "✗ not-registered." Now 401/403 with the `unknown_agent` marker and a resolved local key correctly reports not-registered, with the fix hint.
- **`flair init` wires all three legs (#600)** — init now installs the `SessionStart` hook + CLAUDE.md line alongside the MCP block, instead of leaving them manual (silent partial setups). `--skip-hook` / `--skip-claude-md` opt-outs; prints the exact missing snippet when skipped.
- **`flair-mcp` auto-sets presence on session-start + rate-limited heartbeat (#608, closes #598)** — the session-start hook and bootstrap seed `activity`/`currentTask`; every other MCP tool call refreshes `lastHeartbeatAt` (rate-limited, 3min default). Fire-and-forget + fail-open — never blocks a tool call or startup. Complements #601's read-side gating below.
- **Version-behind nudge (#594)** — `flair status` / `doctor` surface when the installed version is behind the published latest (cached, offline-tolerant, never blocks).
- **`agent add` / `principal add` admin-pass fallback (#593)** — fall back to the local `~/.flair/admin-pass` file instead of hard-requiring `--admin-pass`.

### 🔒 Security

- **OAuthAuthorize consent required real auth; Presence PUT/DELETE scoped correctly (#609, closes #604)** — closes the `authorizeLocal` escalation class: a credential-less loopback POST (which Harper's `authorizeLocal` forges as `super_user`) could mint an admin OAuth code without a real `Authorization` header. Loopback-only, HIGH severity — verified **not** remotely exploitable (Fabric rejects the unauthed remote request with 401). Also scopes the `/Presence` early-return to GET-only so PUT/DELETE correctly transit the auth middleware, and fixes a pre-existing bug where `Response.redirect`'s immutable Headers 500'd every `POST /OAuthAuthorize` on main.
- **`Presence.currentTask` gated to verified readers (#601, closes #592)** — anonymous `GET /Presence` returned agents' freeform `currentTask` (which can hold customer/host/incident strings) verbatim on a public endpoint. Now gated behind a verified Ed25519 signature (not just `resolveAgentAuth`, which Harper's `authorizeLocal` can spoof for a loopback caller) — anonymous, loopback, and Basic-admin callers get the low-risk roster with `currentTask` nulled; the rest of the roster stays public.

### 📦 Dependencies

- **harper 5.1.14 → 5.1.15 (#595)** — pins the models extension API (`registerBackend`, unblocks sovereign local embeddings), replication/deploy reliability fixes, and the MCP row-level RBAC fix. Also fixes the Fabric deploy abort.

### 🧹 Tooling / CI / hygiene

- **Wire `flair-mcp` package tests into the merge gate (#605, closes #491)** — the 34 `packages/flair-mcp/test/*` tests weren't gated by CI (root `test.yml` only ran `test/unit/`); now builds `flair-client` first (flair-mcp imports its built `dist/`), then runs the package's own suite.
- **Self-healing CI/deploy**: timeout+retry the flaky sfw (Socket-firewall) install (#583), retry peer-replication with `--ignore-replication-errors` on deploy (#582), de-flake the E2E CLI smoke test (#584).
- **Strip internal ops-* tracker refs from shipping comments/tests (#586)** — consumer-facing code references public flair# issues only.
- **DESIGN.md in-repo (#579)** — design invariants documented adopter-facing.

## [0.20.1] - 2026-07-05

### 🛠 Self-verifying `flair deploy` (#573)

The deploy CLI can no longer report false success — it verifies the deployed component is actually serving before declaring victory.

- **Timeout passthrough** — `--deployment-timeout` / `--install-timeout` (default 600000, env `FABRIC_DEPLOYMENT_TIMEOUT` / `FABRIC_INSTALL_TIMEOUT`), threaded into the harper deploy args. Fixes the 120s peer-replication abort that previously forced hand-rolled deploys.
- **Post-deploy served-API verification** — after harper reports success, the CLI polls the served target through the post-deploy restart, then GETs each of the component's resources (derived from the built package, not hardcoded) and **fails loudly on 404** (`component is not serving; likely deployed the wrong package root`). A 401/200 means serving. `--no-verify` escape hatch; `--verify-resource <name>` override; `--verify-timeout <ms>` (default 300000). `flair upgrade` inherits the same protection.

## [0.20.0] - 2026-07-05

Writer-controlled memory sharing (Kris flair#522/#550), a memory recall-correctness sweep, and cross-agent authz hardening.

### ✨ Writer-controlled memory sharing (#522 / #550)

- **Layer 1 — `Memory.visibility` = private/shared + centralized read-scoping (#565).** A single chokepoint (`resolveReadScope`) that every cross-agent read path routes through (Memory.search/get, SemanticSearch, MemoryBootstrap, the by-id guard). Durability-keyed default (permanent/persistent → shared, ephemeral → private); a `private` memory is never returned to a non-owner on any path. Migration-invariant — existing memories keep their exact access (`visibility != private` treats no-visibility as shared). Also deletes the SemanticSearch `visibility=="office"` global read leak.
- **Surface teammate findings (#568).** Bootstrap surfaces grant-visible teammate memories relevant to `currentTask` in a distinct, attributed section; the agent's own-context sections stay own-only.

### 🔧 Memory recall correctness

- **Dedup signal on singleton results (#564).** Harper omits `$distance` when a cosine-sort result set is a singleton → dedup silently scored 0. Fallback: point-lookup the candidate and compute cosine directly.
- **Superseded records no longer resurface in recall (#566 SemanticSearch/BM25, #567 bootstrap).** A server-superseded record (past `validTo`, not archived) not co-present with its successor could resurface; now excluded unconditionally in every recall path.
- **openclaw-flair supersede: write-new-before-close-old + observable failure (#563).**

### 🔒 Security

- **Cross-agent delete authz regression guards** for `Relationship.delete` (#569) and `Credential.delete` (#570) — both verified safe against real Harper (the target record is bound before the method runs), now guarded so a future refactor can't silently reintroduce a bypass.
- **Consolidated 3 Ed25519 nonce caches + crypto helpers into one shared guard (#559).**

### 🧰 Tooling / CI

- **`release.sh` aligns bun.lock leaf specifiers after bump** — stops the recurring `--frozen-lockfile` desync (#560).
- **Fail-fast timeouts on the two timeout-less CI jobs** whose sfw (Socket firewall) install could hang and block merge indefinitely (#571).
- **Real-Harper dedup/supersede e2e** (#562, which found the singleton dedup-signal gap above) + Memory.get RequestTarget routing coverage (#561).

## [0.19.0] - 2026-07-03

The read-gate security sweep: three distinct anonymous/cross-agent read exposures, all found from one Sherlock sweep RED and closed.

### 🔒 SECURITY: Memory/Soul by-id reads were ungated — anonymous content leak (#556)

Memory and Soul gated writes and `search()` but defined no `allowRead()` and no `get()` override, so Harper's direct by-id path (`GET /Memory/<id>`) and the collection-describe (`GET /Memory`) were ungated — an anonymous caller received full record content, and a verified non-admin agent could read another agent's memory by enumerable id (`search()` only guarded the query path). Fix: `allowRead()=allowVerified` on both; an owner/grant-scoped `get()` on Memory (**404 never 403**, no id enumeration) branching on `isCollection` so collection/query reads delegate to the already-scoped `search()`; `delete()` reads via `super.get()` to preserve the permanent-delete guard.

### 🔒 SECURITY: admin console reachable by verified non-admin agents (#557)

**P0, live-confirmed.** The `/Admin` auth-middleware gate only 401s requests with **no** Authorization header; a validly-signed non-admin Ed25519 agent passed verification, de-elevated to `flair-agent`, and reached the seven custom `Admin*` resources — which had no `allowRead` — returning the full admin console (`/AdminMemory` all-agents memory browse + provenance, `/AdminPrincipals`, `/AdminDashboard`). Fix: `allowRead()=allowAdmin` on all seven (Basic super_user and admin agents retain access; non-admins → 403).

### 🔒 SECURITY: family read-gate — WorkspaceState / Relationship / Integration / MemoryGrant (#557)

The same by-id/describe leak class as Memory: `search()` and writes gated, but no `allowRead()`/`get()`. Fix: `allowRead()=allowVerified` + `isCollection`-branched owner-scoped `get()` (**404 never 403**) on all four; MemoryGrant scopes `ownerId` **OR** `granteeId` (both parties to a grant); `delete()` uses `super.get()`.

## [0.18.0] - 2026-07-03

### 🧠 Memory integrity: the dedup gate no longer silently loses writes (#553 — closes #526, #548)

`memory_store`'s dedup gate was raw-cosine-only at 0.95 and **silently dropped** the new write on a match — so distinct-but-topically-close findings vanished (#526, the field case: replication route-directionality vs an unrelated DDL/schema memory) and update-intent writes preserved stale state (#548). Since `flair-mcp` enabled dedup by default, every MCP write was exposed. The fix:

- **Never-silent-loss invariant** — the gate never suppresses a write. It always writes; a near-duplicate is surfaced only as a signal (`deduplicated` / `matchedId` / `matchConfidence`), never a reason to drop.
- **Conservative same-fact detection** — a candidate is a duplicate only if cosine **AND** lexical (Jaccard token-overlap) both clear their thresholds, so a topic collision (high cosine, low lexical) is no longer merged.
- **Gate moved server-side** into `Memory` — both the HTTP write path and the native `/mcp` path (which previously had *no* dedup) now behave identically.
- **`memory_update`** (new MCP tool, both surfaces) — id-targeted, dedup-bypassed, default **same-id overwrite**; opt-in supersede-link mode. Retires the racy, identity-breaking delete+store workaround.
- **Supersede is transactional + observable** — validity-window close is write-new-before-close-old and logs on failure (no more silent `.catch(() => {})`); a cross-agent supersede requires a `write` grant.

### 🔎 Cross-encoder reranker in SemanticSearch — default-OFF (#496)

An in-process cross-encoder re-scores query+candidate together and reorders the retrieval set before the final slice, composing with the BM25+union-RRF hybrid path, fail-open to vector order. **Default-OFF** behind `FLAIR_RERANK_ENABLED`; enabling waits on the recall measurement gate.

## [0.17.0] - 2026-07-02

### 🔒 SECURITY: cross-agent isolation break — `getContext()` not `this.request` (#551)

**P0, live-confirmed.** Harper v5 never populates `this.request` on `Resource` subclasses; the #236/#487 `getContext()` sweep missed 8 handlers, so their per-agent ownership guards silently read `undefined` and became dead no-ops (fail-open). Any verified agent could read any other agent's **WorkspaceState** (`GET /WorkspaceLatest/{id}`) and **OrgEvent catch-up feed** (`GET /OrgEventCatchup/{id}`), and every approved **OAuth consent grant** was minted for the `admin` principal regardless of who approved it.

All 8 handlers now resolve identity via the canonical `resolveAgentAuth(getContext())` helper (the same path 31 other resources already use), with **fail-closed** guards (anonymous → 403; a verified agent may only reach its own id; internal/admin pass). The OAuth authorize handler now returns 401 on an unresolved principal instead of silently granting `admin`. A new NECESSITY test suite (`cross-agent-isolation.test.ts`) asserts cross-agent reads are **denied** — the coverage gap (the deelevation suite only tested self-reads) that let this ship green — confirmed to fail on the unpatched tree and pass after the fix. Also fixes three fail-*closed* functional breaks from the same root cause (AgentSeed onboarding, IngestEvents, AdminMemory query params).

### ✨ Bootstrap: team roster + cross-agent search nudge (#549)

`BootstrapMemories` now emits a fixed-cost `## Team` section listing the other active agents in the office with a nudge to search their memories before deep-diving an unfamiliar problem — bootstrap previously only ever loaded the caller's own context, so agents never learned teammates' findings were one `memory_search` away. Agent IDs are wrapped via `wrapUntrusted` (registrant-chosen, untrusted). External contribution from @kriszyp.

### 🔐 Native `/mcp` OAuth surface — Model 2 (custom `withMCPAuth`-guarded handler), default-OFF

Flair speaks MCP natively over a custom in-process `/mcp` JSON-RPC handler wrapped with `@harperfast/oauth`'s `withMCPAuth` — a per-agent OAuth identity replaces the local `flair-mcp` stdio proxy's key-holding. This is the **Model 2** path (Nathan approved 2026-07-01): a custom handler rather than Harper's native application-MCP profile, so it sidesteps the Harper native-MCP gating gaps and is curated **by construction** (the handler only implements the 9 flair tools — no raw CRUD surface).

**Default-OFF behind `FLAIR_MCP_OAUTH`.** When the flag is unset (the shipped default), flair boots byte-identically: no `/mcp` route is registered, `@harperfast/oauth` is never imported, and the default auth chain (Ed25519) is unchanged. `resources/auth-middleware.ts`, `XAA.ts`, `OAuth.ts`, `config.yaml`, and every delegated handler resource are **untouched**.

- **`resources/mcp-handler.ts`** — a minimal MCP handler (`initialize` / `tools/list` / `tools/call` / `ping`). On `tools/call` it resolves the `withMCPAuth`-verified token `sub` → a flair `Agent` via `Credential(kind:"idp", idpSubject=sub)` → `principalId` (the same identity surface XAA uses), establishes the `request.tpsAgent` scoping context, and delegates to the existing resource handler. An unresolvable `sub` is **denied** — never run as anonymous or admin. JIT-provisioning of an unknown sub is gated behind an explicit trust anchor (`FLAIR_MCP_JIT_PROVISION`, default OFF).
- **`resources/mcp-tools.ts`** — the 9 curated tools (memory_search/store/get/delete, bootstrap, soul_set/get, flair_workspace_set, flair_orgevent), each a thin wrapper over the existing handler (Memory / SemanticSearch / BootstrapMemories / Soul / WorkspaceState / OrgEvent). Handlers lazy-loaded so the /mcp module graph carries no top-level Harper link. Fixed a soul-keying bug carried from the design-A slice (soul_set now PUTs with `id = agentId:key` so soul_get can find it).
- **`resources/mcp-oauth.ts`** — registers `server.http(withMCPAuth(mcpHandler), { urlPath: '/mcp' })` **only when the flag is on** (its own dispatch chain; flair's default auth-middleware doesn't run for `/mcp`). `getConfig` pins issuer/resource so iss/aud checks match the minted tokens.
- **Sherlock's 4 reqs:** (1) short-lived tokens via `mcp.accessTokenTtl` (5–15 min) + refresh; (2) RS256 pinning — the plugin is RS256-only by construction (`none`/HS256 structurally rejected); (3) dual-auth precedence — `/mcp` is OAuth-only on its own chain, Ed25519 never reaches it, they can't collide; (4) DCR authentication via `initialAccessToken` + the JIT trust anchor.
- **`@harperfast/oauth@2.1.0`** added exact-pinned; on the supply-chain keep-current allow-list (same high-trust `@harperfast/*` owner as `@harperfast/harper`; only loaded when the default-OFF surface is enabled — zero exposure in the default build). Documented in `docs/supply-chain-policy.md` and `docs/notes/mcp-oauth-model2.md`.
- **Deferred (not shipped):** live `config.yaml` wiring of the AS plugin (kept out to preserve byte-identical flag-OFF; documented for operators) and migrating the homegrown `OAuth.ts`/`XAA.ts` (deprecate-don't-delete — they stay for the Ed25519 path).

## [0.16.1] - 2026-07-01

### 🐛 `flair upgrade` — detect an installed-but-stale flair-mcp, drop openclaw noise, fix formatting (#543)

The bin `--version` probe missed a globally-installed `flair-mcp` (older installs predate `--version`) → it now falls back to the lib probe (reads the installed `package.json` version, version-independent), so a stale-but-present flair-mcp is correctly detected. The `openclaw-flair` line is suppressed when openclaw isn't installed (still shown under `--all`), dropping noise on machines without openclaw. Fixed a double-space in the restart hint. Added a one-line scope note: `flair upgrade` covers the npm-global surface + openclaw plugins; `pi-flair` / `langgraph-flair` / `n8n-nodes-flair` / `hermes-flair` upgrade within their own ecosystems. Fixes the stale-flair-mcp detection gap (surfaced by Kyle's real-world use).

### 🤖 Auto-cut GitHub releases from the CHANGELOG on tag (#544)

Every `v*` tag now creates its GitHub release from the matching CHANGELOG section — idempotent (create-or-edit), injection-safe (tag/version passed via env, notes via `--notes-file`), and independent of the npm 2FA staging gate.

## [0.16.0] - 2026-06-29

### 🧪 CI clean-VM gate — exercise the REALISTIC user env so the #538 embeddings showstopper can't silently regress

The #538 fix (above) addressed a fresh `sudo npm install -g @tpsdev-ai/flair` leaving semantic search **dead** (model targeted the root-owned package dir; Harper-as-user couldn't write it). The uncomfortable part: **CI never caught it.** The existing `docker/Dockerfile.test` from-scratch job runs as **root** (no perms mismatch) *and* sets `FLAIR_MODELS_DIR=/opt/flair-models` (a writable override), so its "clean install" is not the user's environment — root + a pre-solved model path made the bug structurally invisible. The tarball smoke test (`test.yml`) also installs as root and its write/search round-trip uses a **keyword-matching** marker, so it passes even with embeddings dead.

This adds a gate that reproduces what a real user actually has:

- **New `docker/Dockerfile.clean-vm` + `docker/test-clean-vm.sh`.** Builds the **HEAD tarball** (`npm pack`, the exact published file set), installs it **globally as root** (`npm install -g` → root-owned `/usr/lib/node_modules` package dir), creates a **non-root `flairuser`**, and runs `flair init` + the daemon **as that user with NO `FLAIR_MODELS_DIR` override** — the real default model-path resolution (`<ROOTPATH=~/.flair/data>/models`, the #538 default). The embeddings model is pre-staged at that exact user-owned path (to avoid an ~80MB live download stalling the seed loop); if #538 regresses and the model resolves back to the package dir, that staged copy is in the wrong place → `EACCES` on download → DEGRADED.
- **The assertion is genuine semantic recall, not keyword match.** The gate asserts `flair init` reports `Semantic search operational` (the #533 in-init check, which prints `DEGRADED` but does *not* exit non-zero), then runs `flair doctor` as the hard gate — `doctor` performs the same embed→**paraphrase** round-trip (`verifySemanticSearch`: query "a cat hunting a mouse in the evening" vs. content "feline predator stalked its rodent quarry at dusk", **zero keyword overlap**, real semantic score > 0.05) and `process.exit(1)` on degraded. Keyword-only fallback cannot satisfy it. Embeddings dead → the gate FAILS.
- **Wired into `.github/workflows/docker-test.yml`** as a new `clean-vm-gate` job that runs on PRs, alongside (not replacing) the existing from-scratch job — the from-scratch coverage stays, the gate adds the realistic non-root / no-override variant. Each Docker build uses a distinct GHA cache scope. Validated locally: builds + runs green on current main (post-#538) with a real semantic score; the assertion is semantic, so it would catch a regression that the old root-+-override CI could not.

### 🩺 Fix dead semantic search on a sudo/root-owned global install — model dir defaults to `~/.flair`

A fresh `sudo npm install -g @tpsdev-ai/flair` left semantic search **dead**: the package landed root-owned (e.g. `/usr/lib/node_modules`), Harper runs as the *user*, so the embeddings model download hit `EACCES` and recall silently fell back to keyword-only. The `flair doctor` / `flair init` round-trip check (#533) caught it loud, but recall was still broken — this fixes the underlying cause.

**Root cause (corrects the "onboarding dogfood round 1" note below).** The blocker was the **model path**, not the `node_modules/harper` symlink. Flair loads itself as a Harper component in-place (`harper run .`, cwd = the package dir), and Flair's own embeddings wrapper (`resources/embeddings-provider.ts`) hard-coded the model dir to `join(process.cwd(), "models")` — i.e. **inside the package dir**. On a root-owned install that's read-only to the user-run Harper, so the model can't download and `init()` fails. Verified end-to-end with a faithful repro (read-only `<packageDir>/models`, isolated HOME/data/free port): pre-fix → `✗ Semantic search DEGRADED`; the componentLoader's `node_modules/harper` symlink `EACCES` is caught-and-logged (componentLoader.js, no rethrow) and Flair imports nothing from `harperdb`, so it is **non-fatal** — the model path was the only real sink.

- **The embeddings model dir now defaults to a user-writable location, never the package dir (`resources/embeddings-provider.ts`).** New `resolveModelsDir()` resolves, in order: `FLAIR_MODELS_DIR` (explicit override) → `<ROOTPATH>/models` (Harper's data dir — Flair passes `ROOTPATH = ~/.flair/data` when it spawns Harper, so this is user-owned and writable even under a root-owned install) → `<cwd>/models` **only if a model is already cached there** (backward compat for existing writable installs — reuse, don't re-download) → `~/.flair/data/models` (last resort). Aligns with the principle that everything Flair writes lives under `~/.flair` and the package dir stays read-only. `FLAIR_MODELS_DIR` (already used by `docker/Dockerfile.test`) is now an actually-wired override on the production path, not just a dev/docker affordance. Under the read-only-install repro, embed→paraphrase-search now round-trips with a real semantic score (~0.74) and doctor's #533 check passes.
- **Test harness reuses the pre-downloaded model via the override (`test/helpers/harper-lifecycle.ts`).** With the new `<ROOTPATH>/models` default, the integration harness (fresh temp `installDir` per `startHarper`) would otherwise re-download the ~80MB model every run (HuggingFace 429-prone, #463/#465). The harness now sets `FLAIR_MODELS_DIR` to the repo-root `models/` that CI/local pre-download into; a pre-existing parent `FLAIR_MODELS_DIR` still wins.
- **New unit coverage (`test/unit/embeddings-models-dir.test.ts`)** asserts the resolution order, including the load-bearing invariant: a fresh install with no `ROOTPATH` and no cached model resolves to `~/.flair`, **never** the read-only package dir. Full unit suite (1155) green; HNSW / agent-journey / smoke / durability integration tests green (real-embeddings paths exercised).

### 🛟 Loud Node-version preflight for `flair-mcp` — silent failure on old Node

The `flair-mcp` bin (`dist/index.js`) is an ES module: top-level imports are hoisted and the whole module graph is linked + evaluated before the file body runs. flair-mcp's deps (`@modelcontextprotocol/sdk`, `@tpsdev-ai/flair-client` and its transitive deps) need a modern engine, so on an old Node the import graph crashes during linking — **before** any in-file version guard could run. Result: a user wiring `npx -y @tpsdev-ai/flair-mcp` on an unsupported Node gets zero output and a dead MCP server, with no actionable signal. This is the same exposure flair's CLI had, fixed in #524 — now mirrored for the MCP server.

- **The `flair-mcp` bin now points at a CommonJS preflight shim** (`dist/mcp-shim.cjs`, compiled from `src/mcp-shim.cts`). CJS evaluates top-to-bottom with lazy `import()`, so the Node-version check runs and prints **before** anything loads the ESM server or any modern dep. On an unsupported Node → an actionable message (`flair-mcp requires Node.js >= 22. You are running Node.js X. ... https://nodejs.org/`) + `process.exit(1)`. On a supported Node → a transparent no-op that dynamically imports the server and hands off to `runMcp()`.
- **The shim uses only ancient-safe syntax** (`var`, plain functions, string ops, `console.error`, `process.exit`) so the guard itself can never fail to parse on the oldest Node a user could have. `node --check` confirms parse-safety.
- **`src/index.ts` now exports `runMcp()`** — all runtime side effects (the `FLAIR_AGENT_ID` check, `FlairClient` construction, the parent-exit watcher, tool registration, the stdio connect) moved inside it, so merely importing the module (from the shim before the version check, or from a test) does nothing until `runMcp()` is called. Direct invocation (`node dist/index.js`, `bun src/index.ts`) still works via an `import.meta.main` entry-point guard.
- **`engines.node` bumped `>=18` → `>=22`** to match flair's CLI and the deps' real floor, so `npm install` also warns on an unsupported Node. Postinstall now `chmod +x` the shim.
- New unit test (`test/mcp-node-preflight.test.ts`) proves: loud non-zero failure on a simulated old Node without loading the ESM server, no-op handoff to `runMcp()` on the supported Node the suite runs on, and parse-safety of the emitted shim. (packages/flair-mcp/*)

### 🛟 Harper watchdog now recovers an UNLOADED launchd job + alerts on state transitions

On 2026-06-27 ~04:20 prod Flair (`:9926`) was **down** — the `ai.tpsdev.flair` launchd job wasn't loaded (no Harper PID) — and it stayed down, undetected, until a memory write happened to fail. Two gaps: (1) `harper-watchdog.sh` only handled the *PID-alive-but-`/Health`-dead* zombie case (`kill -9` + `launchctl kickstart -k`); `kickstart`/`start` are **no-ops on an unloaded job**, so the job-unloaded failure mode went unrecovered. (2) There was **no alerting at all** — a Flair-down was invisible. Recovery was a manual `launchctl load ~/Library/LaunchAgents/ai.tpsdev.flair.plist`.

The watchdog now recovers **both** failure modes and makes the event **known**:

- **Unloaded-job recovery.** When `/Health` fails, the watchdog now distinguishes by `pgrep harper.js` + `launchctl print gui/$(id -u)/<label>` (with a `launchctl list` fallback). PID-alive → the existing zombie path (`kill -9` + `kickstart -k`). No PID + job loaded → nudge with `kickstart -k`. **No PID + job unloaded (the incident)** → `launchctl bootstrap gui/$(id -u) <plist>` with a `launchctl load` fallback — the operation that actually reloads an unloaded job.
- **State-transition alerting (non-spammy).** A small `up`/`down` state file (`~/.tps/state/harper-watchdog.state`) gates alerts so they fire on **transitions** (down→recovered, or first failure-to-recover), not every 60s tick. Alert channel preference, reusing the house pattern from `mail-deliver-health.sh` / `mail-loop-canary.sh`: Discord webhook (`~/.tps/secrets/discord-webhook-tps-activity`, #tps-activity) → `tps mail send flint` fallback → a loud structured line to the watchdog log + stderr (always). A flair-down/recovery is now loud.
- **Healthy + zombie paths intact.** `/Health` OK still exits silently (and clears any prior down-state, emitting a single RECOVERED alert on the down→up edge). The deadlock/zombie kill-and-restart path is unchanged, and the stale-build deploy tail is preserved.

`bash -n` clean; all three cases (health-OK silent, health-dead+job-loaded kickstart, health-dead+job-unloaded bootstrap) plus the recovered / sustained-down / self-healed / mail-fallback transitions were dry-run against a stubbed `launchctl`/`curl`/`pgrep` harness (never against live prod). The live `ai.tpsdev.flair-watchdog` picks up the new script on its next 60s run after merge — no plist change required. (scripts/harper-watchdog.sh)

### 🔒 Exact-pin all runtime deps + Renovate with a supply-chain cooldown

Four root runtime deps were `^`-ranged install-defaults rather than deliberate choices — `jose` (`^6.2.2`, in the auth/JWT path), `tar` (`^7.5.13`, in packaging), `js-yaml` (`^4.1.1`), and `@types/js-yaml` (`^4.0.9`). A user's `npm install -g @tpsdev-ai/flair` resolves `^` ranges **fresh** — npm does not consume our committed `bun.lock` — so a fresh install could pull a newer, untested (or freshly-compromised) version than anything we shipped or tested. This is exactly the surface `docs/supply-chain-policy.md` §2 already mandated against ("exact-version pinning for production deps") but nothing enforced.

- **All ranged production + dev deps are now exact-pinned to the lockfile-resolved versions** (pin to what we tested — no version bumps): root `jose` `6.2.2`, `tar` `7.5.13`, `js-yaml` `4.1.1`, `@types/js-yaml` `4.0.9`, plus devDeps `@playwright/test` `1.59.1`, `@types/tar` `7.0.87`; and `packages/pi-flair` devDeps `@types/node` `24.11.0`, `typescript` `5.9.3`. `peerDependencies` are intentionally left as ranges (host-provided, not installed). `bun.lock` is version-identical — the resolved `packages:` block is byte-for-byte unchanged; only package.json spec strings tightened (and a pre-existing stale `pi-flair → @tpsdev-ai/flair-client` lock entry corrected to `0.15.0`). This brings `jose`, `tar`, and `js-yaml` under the `check-dep-ages.mjs` bake-time guard, which previously **skipped them** because it only checks exact-pinned deps (the guard now covers 10 production deps, up from 8). (package.json, packages/pi-flair/package.json, bun.lock)
- **Renovate config added (`.github/renovate.json`) for deliberate, test-gated updates with a supply-chain cooldown.** `minimumReleaseAge: "7 days"` matches the `FLAIR_DEP_MIN_AGE_DAYS` default (7) enforced by `scripts/check-dep-ages.mjs` and documented in the policy — Renovate only proposes versions past the bake-time, so a freshly-published (possibly compromised) version has to survive the detection window before it's even suggested. Updates are PRs only (`automerge: false`) — every bump flows through the full test suite + K&S review, never a surprise install. `rangeStrategy: "pin"` (pin-mode aware), grouped non-major / isolated major PRs, weekly schedule, and a keep-current allow-list (`@harperfast/harper`, `harper-fabric-embeddings`) mirroring the script's `DEFAULT_KEEP_CURRENT` so Renovate and the bake-time guard stay in lockstep. Vulnerability alerts bypass the cooldown (security fixes ship immediately). Validated against the latest `renovate-config-validator`. Policy doc §2 updated to reflect Renovate is now enabled (deliberate, cooldown-gated, never auto-merge). (.github/renovate.json, docs/supply-chain-policy.md)

### ⬆️ Bump bundled Harper 5.0.21 → 5.1.14

The bundled `@harperfast/harper` dependency moves from `5.0.21` to `5.1.14`, retiring the 5.0.21 pin that has been the source of recurring friction — the `packageComponent` empty-tarball bug under `node_modules` (#513) and the `flair upgrade --target` override dance that hard-coded a `>= 5.1.13` Harper pin to work around it. The Fabric already runs Flair on 5.1.14 (proven in production), so this brings the bundled dep to parity. This is step 0 of the native-MCP arc (#520): 5.1 unlocks Harper's native MCP support and the OAuth plugin.

Full unit (1151) + integration (129) suites pass on 5.1.14, and `flair init` / `flair doctor` confirm embeddings load and semantic recall works (paraphrase round-trip, score ~0.74) in a writable environment. The 5.1.x dependency tree swaps the storage native bindings (`@harperfast/rocksdb-js` 1.3.0 → 2.3.0, `lmdb` 3.5.4 → 3.5.5) and pulls a new, **optional** `react-native-fs` subtree transitively via `alasql` 4.6.6 → 4.17.3 (never `require`d in a server/Node context). (package.json, bun.lock)

**CI Docker image synced to match (Harper bump follow-up).** The E2E and smoke jobs spun up the `harperfast/harper:5.0.1` Docker image while the bundled npm dep was already 5.1.14 — validating a different Harper runtime than ships to users. Both pins (`.github/workflows/test.yml`, `.github/workflows/smoke.yml`) now use `harperfast/harper:5.1.14`. The native-spawn (integration) and `workers: 1` + retry (Playwright) HarperFast/harper#386 mitigations are **kept** — they're version-agnostic guards against the concurrent-write race; this PR's Docker E2E/smoke run is what validates whether 5.1.14 still trips it (a real finding if so, since users get 5.1.14 — not a reason to revert). Stale `5.0.1` references in CI/Playwright comments updated.

### 🩺 Onboarding dogfood round 1 — loud failure for dead semantic search + install/UX fixes

A clean-VM dogfood (fresh Ubuntu, new Harper dev) found semantic search **dead out of the box** — a `sudo`/root-owned global install can't write the embeddings model symlink (`EACCES`), so `SemanticSearch` silently fell back to keyword-only — while `flair doctor` reported "no issues found" the entire time. This round makes that failure loud and fixes the surrounding install/UX friction.

- **`flair doctor` / `flair init` now VERIFY semantic search with a real round-trip (FIX 1).** Both store a memory with a distinctive phrase and search for a **paraphrase** (deliberately zero shared keywords), then require the probe to come back with a genuine semantic score. If embeddings aren't loaded — the server's keyword-only fallback can't match a paraphrase — doctor/init **fail loudly**: `✗ Semantic search DEGRADED — embeddings not loaded; recall-by-meaning will NOT work` with the common cause (sudo/root install) and a pointer to troubleshooting. The old probe (`{ q: "test" }`, unauthenticated) passed even when embeddings were dead (it 401'd → "cannot verify" → no issue counted). The new check authenticates as a real agent (Ed25519) and is exported (`verifySemanticSearch`) so init and doctor share one gate. New unit test (`test/unit/doctor-embed-verify.test.ts`) asserts the gate FAILS on the `_warning` fallback, a paraphrase miss, and a keyword-only score, and PASSES on a real semantic hit. (src/cli.ts, docs/troubleshooting.md)
- **`flair init` no longer hangs ~60s after printing success (FIX 2).** The MCP smoke-test `setTimeout` was never cleared on success — an un-cleared timer is a live handle that pinned Node's event loop. The timer is now cleared on every settle path, the smoke child is reaped (SIGKILL) even on the resolve path so a lingering `npx` wrapper can't hold the loop, and init exits explicitly once all work is genuinely done (Harper runs detached/unref'd, unaffected). First run returns in a couple seconds. (src/cli.ts)
- **README Quick Start: sudo-free install on a fresh box (FIX 3).** Added Node 22+ install guidance for a stock Linux box (NodeSource / nvm, not just a bare nodejs.org link) and a user-writable npm prefix (`npm config set prefix ~/.npm-global` + PATH) so the happy path needs no `sudo`. A prominent warning explains that `sudo npm install -g` breaks the embeddings component (cross-referencing FIX 1's degraded-search message). (README.md)
- **MCP wiring messages are now accurate and Linux-aware (FIX 4).** The Codex/Gemini/Cursor wire functions used to ALWAYS return "Manual wiring required" (so init could print "✗ manual wiring" and "wired" in the same run). They now actually write the client's real config file cross-platform — Gemini `~/.gemini/settings.json` and Cursor `~/.cursor/mcp.json` (JSON merge, preserving existing servers), Codex `~/.codex/config.toml` (clean create) — and "wired" means a file was written. When they genuinely can't (existing Codex TOML, write error), they say "manual wiring needed" with the correct per-OS snippet, unambiguously. (src/install/clients.ts)
- **`flair agent list` no longer 403s on a healthy fresh install (FIX 5).** Without an admin pass it did an unauthenticated `GET /Agent`; the table's `allowRead` is `allowVerified`, so the natural "did my agent register?" check returned `403 AccessViolation`. It now authenticates as the agent via Ed25519 (`--agent` / `FLAIR_AGENT_ID`, key from `--keys-dir`/standard locations) — a verified agent reads the principal table for discovery. With no agent identity available, a 403 prints actionable guidance instead of a raw AccessViolation. (src/cli.ts)

### 🚪 Onboarding — consolidate `flair install` into `flair init` (one front door)

The git mental model: `npm install -g @tpsdev-ai/flair`, then `flair init`. `flair install` (introduced in v0.15.0 as a separate one-command front door) is **removed entirely** — its full behavior (bootstrap the instance + register the agent + detect and wire MCP clients via the zero-install `npx -y @tpsdev-ai/flair-mcp` form + smoke test) now lives in `flair init`. No deprecated alias: `install` shipped only in v0.15.0 and is referenced by zero external scripts, so an alias would be needless baggage.

- **`flair init` is now the full one-command setup.** It gained `install`'s flags — `--client <claude-code|codex|gemini|cursor|all|none>`, `--no-mcp`, `--skip-smoke` — alongside its existing instance/agent/remote/Fabric flags. With no MCP flag it detects and wires every installed client (Claude Code is auto-wired into `~/.claude.json`; others print copy-paste snippets) and runs an MCP smoke test, then degrades gracefully (warnings, never a hard failure). `--no-mcp` reduces it to the minimal instance + agent bootstrap, so existing callers like `flair init --agent-id X` keep working unchanged.
- **Canonical agent flag is `--agent-id`** (init's existing flag, referenced in docs and callers); `--agent` (install's flag) is kept as a hidden alias so both forms work.
- **Docs updated:** README Quick Start, `docs/integrations.md`, the cross-orchestrator demo cast, and `packages/flair-mcp/README.md` now lead with `flair init`. (second docs pass.)

### 📚 Onboarding consistency — one zero-install MCP-wiring pattern + `flair install` as the front door

Three contradictions in the onboarding story, fixed so the docs and the code agree:

- **MCP-wiring contradiction (FIX 1):** the `flair init --agent-id` auto-wire wrote `~/.claude.json` with a bare `command: "flair-mcp"` (no args), which assumes a global `flair-mcp` on `PATH` — but the README, `docs/`, and the `flair install` client snippets all tell users the zero-install `npx -y @tpsdev-ai/flair-mcp` form. The auto-wire now writes `command: "npx"`, `args: ["-y", "@tpsdev-ai/flair-mcp"]` (src/cli.ts), so init and the docs agree on one pattern. Generated config validated against the Claude Code `~/.claude.json` MCP shape.
- **`flair install` is the documented front door (FIX 2):** the root README Quick Start now leads with the one-command `flair install` (init + agent + MCP wiring + smoke test) and moves the manual `flair init → flair agent add → flair status` flow to an "Advanced / manual setup" section. Corrected an inaccurate `flair agent add --role` example (no such flag).
- **Auth across surfaces documented in one place (FIX 3):** a new "Auth across surfaces" table in `docs/auth.md` (and a pointer in the README) makes the model legible — CLI / SDK / MCP / plugins all use per-agent Ed25519 (default, secure); `n8n-nodes-flair` uses Harper admin-password Basic auth, which grants whole-instance read/write, flagged as a known limitation with the conditions under which it's acceptable.
- **Docs/skills currency:** standardized every MCP-wiring snippet to the `npx -y @tpsdev-ai/flair-mcp` zero-install form (`docs/integrations.md`, `docs/upgrade.md`, `packages/flair-mcp/README.md`, the `packages/flair-mcp/src/index.ts` usage comment) — no remaining bare-binary `command: "flair-mcp"` wiring instructions. The out-of-repo `flair-best-practices` Claude Code skill was updated to match.

### 🛡️ Release hardening — `release.sh` push-auth + impl-term leak check on every PR

Closes the two recurring papercuts from the v0.15.0 release:

- **`release.sh` pushes authenticate via the gh token:** both git-push points (the Phase-1 release-branch push and the Phase-2 tag push) used plain `git push origin`, which fails auth on hosts without a working cred helper for the flair remote (rockit: `Password authentication is not supported`). They now push via the gh token embedded in the remote URL (`git push https://x-access-token:<token>@github.com/tpsdev-ai/flair.git <ref>`), the same PAT-in-URL pattern used everywhere else. The token is read once and never echoed; if no token is available the push fails loudly with recovery guidance. The `-u` upstream tracking on the branch push was dropped (it would persist the token into `.git/config`; the release flow pushes once and opens the PR via the API). The `gh pr create` → `gh api` change from #528 is untouched.
- **Impl-term leak check runs on every PR, scanning the built package surface:** the `check-impl-term-leaks` lint scans `packages/*/dist/`, but the per-PR "Doc/Code Lint" CI job didn't build the packages — so a bead-ref/internal label in a package's **source** comment (which `tsc` compiles verbatim into `dist/`) was invisible at PR time and only failed at release. This is exactly what blocked v0.15.0: a coordination-write-surface comment in `packages/flair-mcp/src/index.ts` carried an internal ref into `dist/index.js`, caught only by the release-time check (#528). The `doclint` job now builds all publishable packages before running the check, so a source leak fails CI on the PR that introduces it, not at release.

## 0.15.0 (2026-06-26)

### 🧹 Release-readiness — impl-term leak cleanup + gitignore + release.sh PR-create fix

Unblocks the release build and removes two recurring release-time papercuts:

- **Impl-term leak cleanup (release blocker):** the `check-impl-term-leaks` lint (pre-commit hook + CI "Doc/Code Lint") flags raw internal references in shipped/user-facing output. A coordination-layer comment in `packages/flair-mcp/src/index.ts` compiled into `packages/flair-mcp/dist/index.js` carrying an internal bead ID + person ref, failing the release build. Rephrased the comment to keep the intent and drop the internal refs — comment-only, no behavior change. The full lint (all freshly-built `dist/`, docs, READMEs) is clean.
- **Gitignore disposable UI artifacts:** added `ui/_shoot*.mjs`, `ui/floor-*.png`, `ui/hero-*.png`, `ui/office-space*.html` (hero-mock screenshot scripts + pngs from prior sessions) to `.gitignore` so they stop dirtying the tree and tripping `release.sh`'s clean-tree check. None were tracked or shipped.
- **`release.sh` PR-create via REST:** the release PR step used `gh pr create`, which 401s with the flint token (it routes through GraphQL). Switched to `gh api -X POST repos/tpsdev-ai/flair/pulls` (REST works) with the same title/body/head/base, so the PR step actually succeeds.

### ✨ `flair upgrade --target <fabric>` — one-command Fabric upgrade

Upgrading a Flair instance deployed to a Harper Fabric cluster used to require a manual deploy dance: stand up a fresh temp dir, hand-write a `package.json` that depends on `@tpsdev-ai/flair@<version>` **and** carries an `overrides` block pinning `@harperfast/harper` to a fixed version (because the published flair declares an old Harper — `@harperfast/harper@5.0.21` as of `flair@0.14.0` — whose component packager emits an empty tarball when the package root is under `node_modules`, flair#513), `npm install`, then run `flair deploy`. `flair upgrade --target <fabric-url>` now bakes that whole thing into one command: it resolves the target version (latest published `@tpsdev-ai/flair`, or `--version`), prepares a clean deployable in an isolated temp dir with the Harper pin (>= 5.1.13) applied automatically, **confirms the staged Harper is the fix version before deploying**, then **reuses `flair deploy`** to push to the Fabric and verifies the result. `--check` shows the version diff + plan without deploying; credentials mirror `flair deploy` (`--fabric-user`/`--fabric-password`, `FABRIC_USER`/`FABRIC_PASSWORD` env) and are never printed. The local-package `flair upgrade` (no `--target`) is unchanged.

### 🐛 Loud Node-version preflight — `flair init` was silently failing on unsupported Node

`flair` (and so `flair init`) silently did nothing on an older/unsupported Node: no error, no output, no `~/.flair`. A Harper dev hit it live onboarding to a Flair office — zero output and no `~/.flair`, fixed only by upgrading Node. Every dev on an old Node hits the same silent wall.

**Root cause:** the CLI bin (`dist/cli.js`) is an ES module. In ESM, every top-level `import` is hoisted and the whole module graph is linked + evaluated *before* the first statement in the file body runs. Flair's deps require a modern engine (`harper-fabric-embeddings` `>=22`, `@harperfast/harper` / `commander` `>=20`), so on an old Node the import graph crashes during linking — *before* any in-file version guard could ever run. The two pre-existing `process.version` checks lived deep inside command handlers, far past the imports, so they never executed; the failure surfaced as silence.

**Fix:** the bin now points at a CommonJS preflight shim (`dist/cli-shim.cjs`, compiled from `src/cli-shim.cts`). CommonJS evaluates top-to-bottom with lazy `require()`/`import()`, so the shim's Node-version check runs and prints *before* anything tries to load the ESM CLI or any modern dependency. The check uses only ancient-safe syntax (`var`, plain functions, string ops, `console.error`, `process.exit`) so the guard itself can never become the thing that fails to parse — it is guaranteed to run and print on the oldest Node a dev could plausibly have. On an unsupported Node it prints a clear, actionable message ("Flair requires Node.js >= 22. You are running Node.js X. Please upgrade: https://nodejs.org/") and exits non-zero. On a supported Node it is a transparent no-op that hands off to the real CLI via `runCli()`. `engines.node` is unchanged at `>=22` (so `npm install` also warns).

### 🐛 `seedAgentViaOpsApi` seeded agents with `kind=null` / `status=null` (invisible to roster/presence) — #521

Remote agent seeding (`flair agent add`, `flair import`, remote init) writes the `Agent` record through the Harper operations API (`operation: "insert"`), which **bypasses the `Agent` resource layer** — so `Agent.post()`'s 1.0 Principal defaults (`kind="agent"`, `status="active"`, `displayName`, `admin`, `defaultTrustTier`, `type`) never ran. The seed body only carried `{id, name, publicKey, createdAt}`, so remotely-seeded agents landed `kind=null, status=null` and were **invisible to roster / presence / Office-Space queries** that filter `status='active'` or `kind='agent'`. `seedAgentViaOpsApi` now writes those fields explicitly, mirroring `Agent.post()` exactly. (closes #521.)

### ✨ BM25 + union-RRF hybrid retrieval (feature-flagged)

Flair semantic recall (HNSW over Q4-nomic embeddings) buries known-good **near-verbatim** memories past rank 100 — outside the HNSW candidate window — so `SemanticSearch` never returns them (confirmed by the recall-eval diagnosis: 6 known-good memories missing in both raw and composite scoring; the misses are lexical exact-term cases the weak embedding cannot surface). This adds a **feature-flagged** BM25 + candidate-union Reciprocal Rank Fusion hybrid path in `resources/SemanticSearch.ts`, between the HNSW candidate fetch and the composite scoring.

- **In-memory per-query BM25** (`k1=1.2`, `b=0.75`, lowercased tokenize, trivial-stopword drop, standard +1-variant IDF) over the caller's scoped corpus — no persistent index, no schema change, no write-path coupling. Extracted to the Harper-free `resources/bm25.ts` so the scoring + fusion are unit-tested against the shipped code.
- **Candidate-UNION RRF** (`rrf = 1/(K+rank_sem) + 1/(K+rank_bm25)`, `K=60`, absent-from-a-list = 0 contribution) over the dedup'd union of the semantic and BM25 (top-50) candidate pools → **normalized** to `[0,1]` (`rrf / max_rrf_in_union`) → fed as the `rawScore` input to the existing `compositeScore`, so durability/recency/`retrievalBoost` and the `RBOOST_RELEVANCE_FLOOR` / `minScore` thresholds all still apply. Naive whole-corpus RRF was rejected (pilot: 0/6 — the broken semantic top-50 floods the fusion and buries BM25's rank-1 hits); union-RRF is the production shape.
- **SECURITY — conditions-filter-before-fusion (the cross-agent trust boundary):** the BM25 candidate corpus is fetched WITH the same `conditions[]` filter the HNSW path uses (agent scoping, archived exclusion, tag/subject), AND the identical predicate + per-record temporal filters are re-applied in-process (`resources/bm25-filter.ts`, `isAllowedBm25Candidate`, fail-closed on unknown comparators) BEFORE the index is built or any score is fused. No other agent's content or term-frequency ever enters BM25 scoring or the union — defense at the boundary, not after fusion.
- **Removes** the `+0.05` exact-substring keyword bump on the hybrid path (BM25 subsumes it). **No-embedding fallback** → BM25-only ranking (RRF degrades naturally as the semantic list is empty). `CANDIDATE_MULTIPLIER` (HNSW fetch size) unchanged; BM25 uses a fixed `SEM_LIMIT=50` candidate window.
- **Feature flag `FLAIR_HYBRID_RETRIEVAL`** (`true` / `1` / `on`; default OFF). **Flag OFF is byte-identical to current behavior** — the legacy HNSW and no-embedding branches are untouched and only the flag-ON path runs the hybrid logic.

Recall-eval (flag-ON vs flag-OFF, against the live flint corpus through the shipped modules): the NEW-8 within-cluster gate **p@3 holds 0.88** (no regression); the OLD-6 severe near-verbatim misses go from **0/6 → 4/6 into top-10** (1/6 into top-3). Sherlock-gated on the security boundary. (spec `FLAIR-BM25-HYBRID-RETRIEVAL`.)

### ✨ Coordination write surface — `flair orgevent` + `flair workspace set` + MCP tools (Kris #510)

Completes the Office Space coordination layer so multi-agent coordination no longer requires hand-rolling signed HTTP (validated need from the Rivet collision dogfood). Adds two CLI commands and two MCP tools that write the coordination layer:

- **`flair workspace set --ref <ref> [--label --provider --task --phase --summary]`** → signed `POST /WorkspaceState`. Writes the agent's OWN workspace state.
- **`flair orgevent --kind <kind> --summary <text> [--detail --scope --target <agentId>…]`** → signed `POST /OrgEvent`. Publishes an org-wide event attributed to the calling agent; `--target` is repeatable for recipients.
- MCP tools **`flair_workspace_set`** and **`flair_orgevent`** mirror the CLI, going through `FlairClient.request()` (Ed25519-signed).

**Attribution is taken from the Ed25519 signature, NEVER the request body — an agent cannot forge another agent's records.** `WorkspaceState.post()` and `OrgEvent.post()` now overwrite the persisted `agentId` / `authorId` with the authenticated identity for non-admin agents (rather than 403'ing a mismatch), mirroring `Presence.post()`'s "agentId from signature, not from body" and A2A `message/send`'s "sender must match params.agentId" no-spoof guard. Anonymous writes stay rejected (401); admin agents may still write on behalf of another agent. The CLI/MCP clients deliberately omit `agentId`/`authorId` from the body. (Kris #510.)

### 🐛 A2A `message/send` couldn't direct a handoff to a peer

The A2A `message/send` handler published an OrgEvent with `targetIds = [agentId]` where `agentId` is the **sender**, so every message was a self-scoped broadcast — there was no way to hand off to a specific peer. (`OrgEventCatchup` returns events whose `targetIds` includes the requesting agent, so a recipient could never receive a message addressed to the sender.) Confirmed live in the Rivet × krais collision dogfood: rivet's `message/send` published an event targeting rivet, and krais never received it. `message/send` now accepts an additive `toAgentId` param — the recipient — and routes the OrgEvent with `scope = sender`, `targetIds = [toAgentId]`, so the recipient's catch-up picks it up. The recipient is validated to exist (`-32004` if not). The no-spoof guard is unchanged: `agentId` is still the sender and must equal the authenticated caller (or admin), so `toAgentId` only controls who *receives* a message, never who it's sent *as*. Back-compat: omit `toAgentId` and the legacy self-scoped behaviour (`targetIds = [sender]`) is preserved, so existing callers don't break. Found in the Rivet × krais collision dogfood.

### 🐛 base64url Ed25519 pubkeys / signatures 401'd (cross-org interop)

An Agent registered with a **base64url**-encoded public key (the `-` `_` alphabet, often unpadded — the JWK / `Buffer.toString('base64url')` form) failed Ed25519 signature verification with a 401. The `b64ToArrayBuffer` decoder was copy-pasted into three auth call sites (`resources/auth-middleware.ts`, `resources/agent-auth.ts`, `resources/Presence.ts`) and had drifted: at least one copy fed url-safe input straight to `atob`, which rejects `-`/`_` ("Invalid character"). The decoder now normalizes base64url → standard (`-`→`+`, `_`→`/`) **and** right-pads with `=` to a multiple of 4 before `atob`, so both standard base64 and (padded or unpadded) base64url decode correctly; standard input is unchanged. To stop the copies re-diverging, the single corrected decoder is extracted to `resources/b64.ts` and imported by all three (same "shared so it can't drift" rationale as HarperFast/harper#1466). Found in the Rivet × krais cross-org dogfood.

### 🐛 `flair import` / `flair agent add` could only seed the Agent on localhost — #514

A remote `flair import <file> --url https://<remote>:9926` split: memories and soul PUT to the remote (correct), but the Agent principal was seeded via `seedAgentViaOpsApi(<numeric ops port>, …)`, which always builds `http://127.0.0.1:<port>` — so the agent record landed on the **local** instance, not the remote. `flair agent add` had the same localhost-only assumption. Both now accept `--ops-target <url>` (env `FLAIR_OPS_TARGET`), and `import` derives the remote ops URL from `--url` (port-1 convention) when `--ops-target` is omitted, so a remote import seeds the agent on the same remote instead of splitting. With neither flag set, seeding stays on localhost — local behavior is unchanged. (Reported by @kriszyp dogfooding the Fabric move — closes #514.)

## 0.14.0 (2026-06-24)

> **A2A discovery fix + office-wide memory sharing from the CLI.** The A2A agent-card now advertises the port a caller actually reached us on (not a hardcoded dead port), and `flair memory add --visibility office` shares a memory team-wide in one step. Both reported by @kriszyp dogfooding the coordination layer.

### 🐛 A2A discovery advertised a dead port — #507

The A2A agent-card `url` (and the streaming catch-up self-fetch) hardcoded port `9926`, but a default local install listens on `DEFAULT_HTTP_PORT` (`19926`) — so a remote A2A peer following discovery hit a dead port. The agent card now resolves the URL the caller actually reached us on (`FLAIR_PUBLIC_URL` → request `Host`/`X-Forwarded-*` headers → `127.0.0.1:${HTTP_PORT}`, mirroring the admin-pane `resolvePublicUrl` from #404), and the in-process catch-up fetch targets the real `HTTP_PORT` loopback. (Reported by @kriszyp — closes #507.)

### ✨ `flair memory add --visibility` — #509

`memory add` now accepts `--visibility <value>` (e.g. `--visibility office`) so a CLI-written memory can be shared office-wide with every team agent in one step, instead of needing a per-pair `flair grant` for each. Omitting it keeps the memory private-by-default. (Reported by @kriszyp — closes #509.)

### 🧹 Internal — #508

The E2E Playwright suite now serializes on CI (`workers: 1`) so concurrent writes don't trip the Docker-Harper HNSW race (HarperFast/harper#386), plus transient connection drops auto-retry — ending the intermittent `socket hang up` / `ERR_CONNECTION_RESET` flake that reddened otherwise-green releases.

## 0.13.0 (2026-06-23)

> **Onboarding that actually works, plus sharper memory hygiene.** First-run `flair install` now provisions an agent cleanly end-to-end, recall stops letting a single hot memory dominate unrelated queries, and consolidation no longer flags brand-new memories for archival. Adds `memory add --derived-from` for reflection provenance, and the auth-middleware suite now runs against real Harper.

### 🐛 First-run onboarding fixed — #501

The one-command `flair install` couldn't register its own agent — it POSTed a Harper ops-API body to the REST root, which 405s as a collection write. Now it seeds via the ops API (the path `flair agent add` already uses). `flair soul set` now PUTs `/Soul/{agentId:key}` instead of POSTing the collection (was 405), and `flair agent list` no longer null-scans the primary key (was 400 on bundled Harper 5.0.21). A new end-to-end onboarding smoke test guards the `install → soul set → agent list` path so it can't regress. (Reported by @kriszyp dogfooding locally — closes #498, #499, #500.)

### 🐛 Recall: bound the retrieval-boost feedback loop — #493

`retrievalBoost` was an unbounded `1 + 0.1·log2(retrievalCount)`, auto-incremented on every recall — a rich-get-richer loop that let a frequently-retrieved memory float to the top of unrelated queries. It's now gated behind a semantic-relevance floor and capped at ×1.1 (a tie-breaker, not an override). Composite recall recovers toward raw and cross-query magnets are eliminated.

### 🐛 Consolidation: don't archive brand-new memories — #505

`rem` consolidation keyed staleness off `lastRetrieved` with no fallback, so a just-written, never-read memory read as "Infinity days" stale and became an archive candidate. Idle age is now `now − (lastRetrieved ?? createdAt)` with a creation-age grace window, and the consolidation scoring is extracted to a Harper-free, unit-tested lib. (Reported by @kriszyp — closes #502.)

### ✨ `flair memory add --derived-from` — #505

`memory add` can now set `derivedFrom` provenance, so the `rem rapid` reflection loop can link a distilled lesson back to its source memories as the prompt instructs. (Closes #503.)

### 🧪 Auth-middleware tests → real Harper — #494

The auth-middleware suite now exercises Harper's real auth chain instead of a simulator — closing the gap that previously let auth bugs slip past K&S-approved PRs.

### 🔧 n8n example: K&S review capture → ephemeral — #497

The shipped `ks-review-capture` example wrote memories at `persistent`, teaching an anti-pattern that floods recall; re-tiered to `ephemeral` with durability guidance in the README.

## 0.12.0 (2026-06-18)

> **Auth-RBAC reshape + Claude Code auto-recall.** The agent-auth boundary moves from a single rejecting gate to a non-rejecting gate plus per-resource self-enforcement, with every agent running as a least-privilege identity. And Flair becomes *automatic* memory for Claude Code: a SessionStart hook injects soul + relevant memories at session start, no manual tool call.

### 🔒 Auth-RBAC reshape: non-rejecting gate + per-agent de-elevation — #487, #489

The HTTP auth boundary is rebuilt. The global gate no longer rejects; it annotates the request and every `@table`/custom resource self-enforces via a three-way verdict (internal / verified-agent / anonymous), denying anonymous writes per-resource. Each agent runs as a de-elevated least-privilege `flair-agent` user instead of admin. Closes anonymous-write holes across Memory, Soul, Integration, Presence, Agent, and the federation/pairing resources, and fixes a phantom-user fallback `getUser` returned for unprovisioned instances. (#487 laid the foundation — per-agent identity + the `flair_agent` role + resource hardening, gate unchanged; #489 flipped the gate and completed per-resource enforcement.)

### 🐛 Fresh hub provisioning: flair_pair_initiator role spec — #488

`add_role` rejected the `flair_pair_initiator` role spec, breaking fresh hub provisioning. Fixed so a new federation hub stands up cleanly.

### ✨ Claude Code SessionStart auto-recall hook — #490

`@tpsdev-ai/flair-mcp` ships a new `flair-session-start` bin: register it as a Claude Code SessionStart hook and every session boots with Flair's `bootstrap` context (soul + relevant memories) auto-injected — Flair as a *push* memory layer, not just pull tools. No-op on any failure (never blocks startup), context clamped, opt-in via `~/.claude/settings.json`. See `docs/mcp-clients.md`.

## 0.11.0 (2026-06-09)

> **Presence & Heartbeat API — the live agent-activity layer.** Agents report liveness and current task via Ed25519-signed heartbeats; a field-allowlisted public read surface exposes derived status (active / idle / offline) without leaking private data. Built as the backend for The Office Space — a live visualization of the agent fleet — and a concrete instance of zero-trust agent identity: an agent can only write its own presence. Ships alongside federation and Harper-lifecycle hardening.

### ✨ Presence / Heartbeat API — #471, #473, #475

Per-agent presence with **Ed25519-authenticated writes** (an agent can only update its own record; forged writes are rejected), a **public read surface restricted to a field allowlist** (no secrets, no admin fields), and configurable active/idle/offline derivation from heartbeat recency. Adds the `flair presence set` CLI subcommand (#473) and a per-agent presence emitter that infers current task from observable signals (#475).

### 🐛 Federation syncs legacy null-`updatedAt` rows — #470

Rows written before `updatedAt` tracking existed were silently skipped by incremental federation sync. Sync now orders by `COALESCE(updatedAt, createdAt)`, so legacy records replicate instead of being stranded.

### 🐛 Liveness ping on no-change federation syncs — #472

A sync that found no changes left host/office liveness stale. It now emits a liveness ping even on no-op syncs, so the fleet view can tell alive-but-idle hosts from dead ones.

### 🔒 Harper-lifecycle env allowlist + listener cleanup — #474

The Harper child process now inherits an explicit environment allowlist instead of the full parent environment, and lifecycle event listeners are detached on teardown to prevent leaks across restarts.

### 🧹 Internal

Test-helper and CI hardening: Golden Path smoke now creates agents via the ops-API insert path that real registration uses (#476, #479), and the implementation-term doc lint no longer false-matches CLI flags (#478).

## 0.10.1 (2026-06-07)

> **Federation pairing + sync hardening.** A multi-host fleet bring-up — three office spokes (one local, two cloud VMs) onto a freshly recreated Fabric hub — surfaced two federation failure paths that stranded the re-pair. Both closed in #464, validated end-to-end (598 + 105 + 11 records replicated, incremental cursor sync confirmed).

### 🐛 `federation pair` always writes the local hub-peer now — #464

`flair federation pair` recorded the hub as a local `Peer` only inside an `if (adminPass)` branch and never checked the upsert result. Pairing with just an agent key — or a silently failed write — left no peer behind a misleadingly green `✅ Paired`, after which `flair federation sync` reported `No hub peer configured` and never ran. The local peer-write is now **mandatory and result-checked**: it errors clearly when admin auth is missing or the write fails, instead of skipping. Also accepts `HDB_ADMIN_PASSWORD` as an admin-pass source.

### 🐛 Sync survives Fabric ingress stalls — #464

Large sync batches could stall at the Fabric ingress with no client-side timeout, hanging the entire sync until the gateway's own ~2-minute timeout fired — the actual mechanism that stranded the re-pair. `runFederationSyncOnce` now applies a **45s per-batch fetch timeout** and **adaptively halves-and-retries** a batch on timeout / abort / 413 / 5xx down to a single record, so one slow stretch no longer aborts the run. Default batch lowered 200 → 50 (the hub merge runs ~1.7s/50 records; the ingress was observed to stall on larger POSTs). Idempotent on the hub (put-by-id), so retries are safe.

## 0.10.0 (2026-05-28)

> **Dogfood-mature hardening.** This release is the result of a multi-day pass through Flair's load-bearing surfaces — federation sync, REM restore, A2A interop, memory_store — looking for silent-failure paths that pass tests but fail in production. Seven were found and closed: a P0 security gap on `/a2a`, a 6-month-old silent data-loss bug in `memory_store`, and five telemetry/observability holes that would have shown "healthy" while data was being dropped. Plus the v0.9.x patch stream (renderer + CLI polish, federation re-upsert fix, smoke tests, README correctness).

### 🔒 A2A endpoint requires authentication (P0 security fix) — #448

`POST /a2a` accepted unauthenticated `message/send` and `tasks/list` against any Flair instance. Live-confirmed: anyone with network reach could forge an `OrgEvent` impersonating any agent (`{"jsonrpc":"2.0","method":"message/send","params":{"agentId":"flint",...}}` returned 200 with no auth) and read all internal Beads issues via `tasks/list`. Same hole bypassed the signed-envelopes delegation chain shipped earlier this week — exactly the boundary it was designed to enforce.

Two-layer fix:
- `auth-middleware` allow-list narrowed to **GET-only** for `/a2a` + `/A2AAdapter`. GET still returns the public agent card per A2A spec. POST/PUT/DELETE fall through to TPS-Ed25519 / admin Basic enforcement.
- `A2AAdapter.post()` defense-in-depth: reads `request.tpsAgent` / `tpsAgentIsAdmin`, returns JSON-RPC `-32001 Unauthorized` if neither set. Plus a sender-match check on `message/send` — non-admin callers can only send AS themselves.

`/AgentCard` stays public — GET-only by design, returns spec-compliant card metadata.

### 🐛 memory_store silent dedup — pi-flair / openclaw-flair / flair-mcp aligned — #450 (closes #449)

`pi-flair`'s `memory_store` silently dropped content when dedup matched an existing memory **from the same agent**. The legacy prefix-match check (`!result.id.startsWith(agentPrefix)`) returned the success path when both IDs shared the agentId prefix — and the new content was discarded with no signal. Reported by an external user after three sequential stores collapsed into two memory IDs.

The same bug class was fixed in `flair-mcp` six months ago (#358), but `pi-flair` was missed. Stale tests asserting the broken predicate hid the bug for that entire window. This release:
- Switches `pi-flair` to the authoritative `result.deduped` flag from flair-client.
- `flair-mcp` now emits MCP `structuredContent: { deduplicated, mergedWith?, written }` so callers see the signal without parsing prose. Prose itself made more explicit: `⚠️ DEDUPLICATED — new content was NOT written`.
- `openclaw-flair` tightened to match either id-mismatch or explicit `deduped` flag (defense-in-depth).
- 3 stale tests replaced with 7 new tests exercising the fixed code path + response shape.

### ✨ Federation: truthful sync telemetry — #444 + #445

The receive-side of `FederationSync.post` previously claimed success when 100% of records were skipped, and silently swallowed per-record errors via `catch { skipped++ }`. Operators saw a green dashboard while data was being dropped — exactly the failure mode the new federation observability work is designed to surface.

- **Liveness vs. progress split** on the `Peer` record. `lastSyncAt` updates on every contact ("we heard from this peer"). New `lastMergeAt` updates only when `merged > 0` ("data actually flowed in"). Conflating them was the smoking gun for "green dashboard while burning."
- **Per-record skip reasons** aggregated into `skippedReasons: Record<string, number>` and surfaced on the response + `SyncLog`. Merge errors now `console.warn` (was silent) and the first 10 are captured in the SyncLog row (capped — hostile peers can't blow up logs).
- **Pure `classifyRecord` extracted** to its own module for unit testability — 10 new tests cover every skip-reason branch + hub-relay + LWW edge cases.
- **`flair federation status` CLI** gains a `last_merge` column next to `last_sync`. The stale-warning is re-anchored on `lastMergeAt` so a peer that "syncs" every 5 minutes but hasn't merged anything in days finally surfaces in the dashboard.

### ✨ REM restore: drift verification + hard-fail on missing agentId — #447 + #446

Two failure modes in `applySnapshot`:

- **Missing `metadata.agentId` bypassed the cross-agent guard** (#446). The original short-circuit `if (metadata.agentId && metadata.agentId !== opts.agentId)` skipped the check entirely when the field was missing — silently allowing restores from pre-v0.9.0, hand-edited, or attacker-crafted snapshots into the wrong agent's state. Now hard-fails on missing OR mismatched.
- **No post-restore state verification** (#447). After the PUT loop, `applySnapshot` returned without ever asking Harper whether the rows landed. Schema coercion, 4xx-masked-as-2xx, partial accepts — all invisible. New default-on verify pass GETs the agent's memories + souls back and **diffs by ID** against the snapshot (per-ID, not count-parity — catches the case where a simultaneous PUT failure + DELETE failure wash out numerically). Drift surfaces as structured fields on `RestoreResult.verified` (`missingMemoryIds`, `extraMemoryIds`, etc.) and bumps `status` to `failed`. Opt-out via `verifyPostRestore: false` for tests that intentionally simulate inconsistent state.

### 🐛 Admin UI URL derivation — #451 (closes #404 + #402)

`/AdminInstance` Endpoints table rendered `http://127.0.0.1:19926/...` URLs on remote deployments where `FLAIR_PUBLIC_URL` wasn't set — operators on Fabric or VPS-hosted Flair couldn't copy-paste their actual hub URL. New resolution order: `FLAIR_PUBLIC_URL` env var (still wins), then **request headers** (`X-Forwarded-Proto`/`X-Forwarded-Host` from a proxy, or direct `Host`), then localhost fallback. Bare host assumes `https`; host with port assumes `http`. Host-header path is gated by a strict regex `/^[\w.\-:]+$/` to reject CRLF / space injection.

Closes #402 (footer "vdev") as a side effect — that fix actually landed back in May (62af140) but the merging PR didn't use `Closes #N` syntax so GH kept the issue open.

### 🐛 Soul stats: honest by-key breakdown — #454 (closes #453)

`flair health` reported a soul severity breakdown (`critical / high / standard / low`) that always read 100% `standard` — dead telemetry. Nothing ever writes `Soul.priority` to a non-standard value (`soul set` has no `--priority` flag, `rem promote --to soul` hardcodes `"standard"`, and bootstrap ranks soul by *key* via `SOUL_KEY_PRIORITY`), and the `?? "standard"` fallback further mislabelled *unset* as *standard*. Same "passes tests, lies in production" class as the federation/REM telemetry fixes above. Soul entries have no severity dimension — they're keyed identity facts (`role` / `project` / `standards` / …), so both `flair health` renderers now show a count **per key** via a shared, tested `sortSoulKeyEntries` helper. Also reconciles the `SoulEntry` client type with the Harper schema (`priority` / `durability` / `metadata` / `updatedAt` were unmodelled).

### ✨ CLI polish: renderer module across all status commands — #427 through #440

Pretty/JSON output unified across the CLI surface. Single renderer module resolves output mode from `--json`, `FLAIR_OUTPUT=json`, or pipe detection. Applied to: `flair status` (all four sub-statuses), `flair federation status`, `flair memory list`, `flair soul {get,set,list}`, `flair rem candidates`, `flair admin {agent,principal,idp} {list,show}`, `flair search` (with rich filters + `--explain`), `flair bridge {list,allow-list}`, `flair test`, `flair doctor`, `flair backup`, `flair inspect`. Status deep mode adds verbose observability + bootstrap context (#427).

### 🐛 Federation re-upsert blob loop — #426

Caught 2026-05-19 after the Fabric cluster hit its 4.7G XFS quota with 5,899 BlobDB entries across 109 unique memory IDs (~54 stored versions per live record). Two compounding bugs:

- **Spoke's `since` cursor never advanced.** `runFederationSyncOnce` read `hub.lastSyncAt` for the `since` cutoff but never updated it after a successful push. Every 5-minute poll re-sent every memory back to the hub.
- **Receiver wrote every record regardless of content equality.** No-op skip check added: if local + remote share the same `contentHash` and remote isn't strictly newer, skip the write. Prevents the BlobDB from re-blob'ing the HNSW embedding on every poll.

### ✨ Backup + ops polish — #424 + #425

- `flair backup --admin-pass-file <path>` (#424) — read admin password from a 0600-mode file instead of env var. Closes ops-147. Mode is enforced at 0600 (#425 follow-up per Sherlock's review).

### 📋 Smoke tests + supply-chain — #442 + #443

- Smoke test scaffold + golden-path e2e scenario (#442).
- CI wraps `bun install` with Socket Firewall (sfw) across all jobs (#443) — supply-chain defense.

### 📝 Docs

- README leads with what Flair IS — tagline + opening rewrite + table prune (#422)
- README correction: REM nightly ships in v0.9.0 — corrects stale "planned" claims (#423)
- Harper Fabric status + admin credentials claim corrected (#441)

## 0.9.0 (2026-05-14)

> **FLAIR-NIGHTLY-REM ships.** The nightly memory hygiene cycle — snapshot, maintenance, candidate staging, and live replay — is load-bearing on a platform-native scheduler (launchd / systemd). "Every cycle is reversible" is a real property: each nightly run snapshots agent state before any destructive op, and `flair rem restore <date> --apply` rewinds Harper state to any snapshot (with its own pre-restore snapshot for rollback). Slice-1 + slice-2 of the spec land in this release; slice-3 (automated distillation via pluggable LLM provider, trust-tier input filter, fail-fast restore) defers to 1.1.

### 🛠 FLAIR-NIGHTLY-REM slice-2 PR-5 — scheduler hardening + 1.0 scope clarifications

- **`spawnSync` timeout** in `src/rem/scheduler.ts` — `launchctl bootstrap`/`systemctl enable --now` invocations now cap at 30s so a hung service manager can't block the CLI indefinitely. Per Sherlock's #415 review nit.
- **Spec § 11 expanded** — documents 1.0 deferrals explicitly: automated nightly distillation (operator runs `flair rem rapid` manually), cross-agent restore, cross-agent reflection, trust-tier input filter, pagination on memory fetch, fail-fast restore (Kern's #418 nit). All ship in 1.1+ as the pluggable distillation provider lands. The 1.0 nightly cycle ships the load-bearing reversibility (snapshot + maintenance + restore) without auto-distillation — distillation stays operator-driven.

### ✨ FLAIR-NIGHTLY-REM slice-2 — live replay (`flair rem restore --apply`)

- **`flair rem restore <date> --apply`** — actually rewinds Harper state to the snapshot, not just extracts the tarball. Sequential client-side restore: takes a pre-restore snapshot of CURRENT state first (so this restore is itself reversible), then DELETEs current memories/souls for the agent, then PUTs the snapshot rows back. The pre-restore snapshot path is reported so the operator can roll back if something goes wrong mid-flight (`flair rem restore <pre-restore-date> --apply`).
- **`flair rem restore --apply --dry-run`** — reports planned delete/restore counts without making any destructive call. Useful for verifying the snapshot's contents match expectations before committing.
- **Cross-agent restore is refused** — the snapshot's `metadata.json` `agentId` must match the `--agent` argument. Prevents accidental rewind into the wrong account if a snapshot tarball was hand-copied.

### ✨ FLAIR-NIGHTLY-REM slice-2 — maintenance step + MemoryMaintenance routing fix

- **`/MemoryMaintenance` endpoint now reachable** — migrated `resources/MemoryMaintenance.ts` from a non-standard `export default class` with `static ROUTE`/`METHOD` (which Harper 5.x doesn't auto-register) to the standard `extends Resource` + `allowCreate()` shape. `flair rem light` was returning "Not found" against this endpoint in production; both `rem light` and the new REM nightly runner now reach it correctly. Response shape extended: `expired`/`archived`/`total`/`errors` are now top-level on the response in addition to the historical `stats` wrapper, so REM-style callers don't need to unwrap.
- **Nightly runner runs `/MemoryMaintenance` after snapshot** — soft-deletes expired memories + soft-archives stale standard session memories (>30 days). Audit row now populates `archived` and `expired`; `slice` field becomes `"2-maintenance"` to distinguish from slice-1 snapshot-only rows. Failure of maintenance after snapshot succeeds: cycle marked `failed`, snapshot preserved, error captured in `errors[]`.
- **`rem nightly run-once` shows archived/expired** — CLI display gained `Archived:` and `Expired:` lines when the maintenance step ran.

### ✨ FLAIR-NIGHTLY-REM slice-1 (scheduler + manual cycle + snapshot/restore)

- **`flair rem nightly enable [--agent <id>] [--at HH:MM] [--flair-url <url>]`** — installs the platform-native scheduler. On macOS, writes `~/Library/LaunchAgents/dev.flair.rem.nightly.plist` and `launchctl bootstrap`s it. On Linux, writes `~/.config/systemd/user/flair-rem-nightly.{timer,service}` and enables the timer. Also deploys `~/.flair/bin/flair-rem-nightly` as the shim the scheduler invokes. Defaults to 03:00 local time.
- **`flair rem nightly disable [--remove-shim]`** — removes the scheduler entry (`launchctl bootout` / `systemctl --user disable --now`). Snapshots at `~/.flair/snapshots/` and the audit log at `~/.flair/logs/rem-nightly.jsonl` are preserved; the shim is preserved by default (pass `--remove-shim` to delete it too).
- **`flair rem nightly status`** — reports platform + install state + scheduler/shim paths. Filesystem-only — matches the health endpoint's existing detection logic.
- **Scheduler templates** — `templates/launchd/dev.flair.rem.nightly.plist.tmpl`, `templates/systemd/flair-rem-nightly.{service,timer}.tmpl`, `templates/bin/flair-rem-nightly.sh.tmpl`. Single-pass `{{KEY}}` placeholder substitution. Shipped in the npm tarball under `files: [..., "templates/"]`.


- **`flair rem nightly run-once [--dry-run]`** — manually invokes the nightly cycle. Same code path the scheduler will use in slice-1 PR-2. Pre-flight pause check, fetch memories+soul, snapshot to `~/.flair/snapshots/<agent>/<iso-ts>.tar.gz`, append a JSON row to `~/.flair/logs/rem-nightly.jsonl`. Slice-2 will add maintenance + trust-tier filter + distillation; the audit row carries `slice: "1"` so readers can distinguish phases.
- **`flair rem snapshot list [--agent <id>]`** — lists snapshot tarballs sorted by mtime descending. Snapshot creation is intentionally NOT exposed as `rem snapshot create` to keep the nightly audit log as the single source of truth.
- **`flair rem restore <date> [--agent <id>] [--target <dir>] [--dry-run]`** — extracts a snapshot tarball to a target directory for inspection. Filesystem-only; live replay (rewind Harper state) is slice-2.
- **`flair rem pause` / `flair rem resume`** — writes/removes `~/.flair/rem.paused` sentinel. The nightly runner checks this first and exits cleanly with `status: "paused"` in the log. `FLAIR_REM_PAUSE=1` env var is honored equivalently for fleet-wide pause.
- **Snapshot format** — tar.gz at `~/.flair/snapshots/<agentId>/<iso-timestamp>.tar.gz` (0600 perms), containing `memories.jsonl` (one Memory row per line), `soul.json` (single row, array of rows, or null), and `metadata.json` (agent id, run id, flair version, counts). Mirrors the existing `flair session snapshot` pattern.
- **Audit log** — `~/.flair/logs/rem-nightly.jsonl` (0600 perms), one JSON row per cycle. Health-endpoint REM block already surfaces `lastNightlyAt`; will show real values once the scheduler lands (PR-2).

### 🐛 Admin UI Fixes (1.0 milestone)

- **AdminMemory list view returns rows again** — dashboard correctly reported 452 memories but `/AdminMemory` rendered "0 memories shown / No memories found." Harper's `archived not_equal true` predicate didn't match rows where `archived` was unset/false; switched to a JS-side filter. (#401, #405)
- **Admin sidebar shows real version, not "vdev"** — `process.env.npm_package_version` is only populated under `npm run`; out-of-process Harper saw it as undefined. Now reads the runtime `package.json` directly so the published binary shows e.g. `v0.8.3`. (#402, #405)
- **`/Admin` redirects to `/AdminDashboard`** — bare `/Admin` returned 404; now 302 to the dashboard so operators bookmarking the path land on the admin UI. (#403, #406)
- **AdminInstance endpoints respect `FLAIR_PUBLIC_URL`** — every Endpoint row hardcoded `http://127.0.0.1:9926/...`, wrong for Fabric / remote-Flair operators. Now falls through to `FLAIR_PUBLIC_URL` env var when set (set it in your launchd / systemd unit / Fabric deployment spec). (#404, #405)
- **`WWW-Authenticate: Basic` on `/Admin*` 401s** — browsers only show the native auth dialog when this header is present; without it, hitting `/AdminDashboard` cold on a remote Flair just renders a 401 page with nowhere to enter creds. Required for Fabric/remote operators to actually use the admin UI from a browser. JSON API endpoints unchanged. (#407)

### ✨ Polish

- **`flair federation status` UX upgrade** — relative timestamps ("3m ago", "5h ago", "2d ago") replace raw ISO strings for `lastSyncAt`; one-line warning when any peer hasn't synced in >24h; auth-failure error now lists the three supported env-var paths (`FLAIR_AGENT_ID` / `FLAIR_ADMIN_PASS` / `FLAIR_TOKEN`) instead of the bare `missing_or_invalid_authorization`. (#396)

### 📚 Documentation

- **Federation CLI reference includes `watch` and `reachability`** — the table in `docs/federation.md` was missing two real commands that already ship: `flair federation watch [--interval <s>]` (daemon-loop sync) and `flair federation reachability` (read-only probe of local + each peer). Also corrected the "manual sync" limitation, which claimed sync had to run via cron — the watch-loop is built-in. (#398)
- **Memory bridges callout in `docs/integrations.md`** — the integrations catalog only described live orchestrator integrations; the 5 shipped memory bridges (Mem0, ChatGPT, claude-project, markdown, agentic-stack) weren't discoverable. Adds a two-line "Adjacent: memory bridges" callout near the top and a "Memory bridges" entry in See also. (#397)

## 0.8.3 (2026-05-11)

### 🐛 Bug Fixes

- **`/Health` endpoint truly public** — `allowRead() { return true }` opens the Harper role gate, making `/Health` work for remote callers. Previously `/Health` returned 401 from outside Harper's `authorizeLocal` localhost-bypass (e.g., calling Fabric-hosted Flair from rockit) even though the handler is intentionally unauthenticated. Pattern matches PR #299's `FederationPair.allowCreate()`. (#386)

### 🛠 Internal

- **`@tpsdev-ai/n8n-nodes-flair` worked example rebuilt** — the q3qf K&S-review-capture workflow replaced the 4-node `ExecuteCommand → Split → ReadBinaryFile → Parse JSON` chain with a single Code node (atomic, version-stable, immune to n8n node-API drift). Filter `containedInList` operator replaced with a Code-node `Set` membership check (the operator parses comma-strings ambiguously across n8n versions). Required env var on the n8n host: `NODE_FUNCTION_ALLOW_BUILTIN=fs,path`. Node icons shipped for FlairWrite / FlairSearch / FlairChatMemory. (#389)
- **`scripts/release.sh` patched** — `openclaw-flair` and `langgraph-flair` added to the internal-deps alignment loop. v0.8.3 attempt caught both packages stuck at `@tpsdev-ai/flair-client@0.8.2` while the workspace bumped to `0.8.3`. (#390 self-fix)

## 0.8.2 (2026-05-11)

### 🐛 Bug Fixes

- **`@tpsdev-ai/n8n-nodes-flair` install regression** — published 0.8.1 hit `No "exports" main defined in flair-client` because of TSC downleveling `await import()` to `Promise.resolve().then(() => require())`. The `FlairWrite` node now imports `@tpsdev-ai/flair-client` via a `Function("return import(...)")` wrapper that defeats TSC downleveling. (#385, #387)
- **FlairApi credential auth fixed** — the n8n expression sandbox doesn't whitelist `Buffer.from`, so the Authorization header expression silently produced an invalid value. Switched to n8n's native `IAuthenticateGeneric.auth.username/password` which constructs Basic auth internally. (#387)

## 0.8.1 (2026-05-08)

### 🐛 Bug Fixes

- **`@tpsdev-ai/openclaw-flair@0.8.0` shipped with a stale `flair-client@0.5.0` dependency** (caught post-merge by Kern review on #367). Anyone `npm install @tpsdev-ai/openclaw-flair@0.8.0` resolved a 3-version-old client paired with the new server. 0.8.1 bumps the dep to match the current major release. No code changes; metadata-only fix.

- **bun.lock regenerated cleanly** so any internal `flair-client@0.7.0`/`@0.5.0` resolution remnants are gone. `bun install --frozen-lockfile` now resolves consistently across every workspace package.

## 0.8.0 (2026-05-07) — BREAKING

### ⚠️ Required migration: `flair reembed` after upgrade from 0.7.x

**If you have existing Flair data written by `@tpsdev-ai/flair@0.7.x`, run `flair reembed` once after upgrading to 0.8.0 before semantic search will work.**

```sh
# 1. Stop your old install
flair stop

# 2. Install 0.8.0
npm install -g @tpsdev-ai/flair@0.8.0

# 3. Start against your existing data dir
flair start

# 4. Re-encode every memory's embedding so it matches the new index format
FLAIR_ADMIN_PASS=<your-admin-pass> flair reembed
```

Why: 0.8.0 ships with `@harperfast/harper@5.0.9` (was 5.0.1 in 0.7.x). Harper's HNSW vector-index storage internals changed across that version range, and embeddings written under 5.0.1 come back in a shape that 5.0.9's cosine path rejects (`Cosine distance comparison requires an array`). `flair reembed` re-computes every memory's embedding via the running version's pipeline and writes it back through the proper PUT path — one-time, idempotent, takes ~30s for 500 memories.

Zero-data-loss: contents, durability, retrieval counts, and all other fields are preserved. Only the stored embedding column is rebuilt. New writes after 0.8.0 work without migration.

Per the pre-1.0 versioning policy, this minor bump is breaking on purpose.

### 🐛 Bug Fixes

- **`flair reembed` no longer hits `/SemanticSearch` to enumerate memories.** The previous implementation called the very endpoint that breaks during a Harper upgrade, so it couldn't recover from the condition it was meant to fix. Now uses the Harper ops API directly (`search_by_conditions` on `flair.Memory`) so the migration path works even when the vector index is in an incompatible state.

- **`flair reembed --agent <id>` also bypasses `/SemanticSearch` when an admin pass is available.** Falls back to the auth-fetch SemanticSearch path only when no admin pass is set (compatible with version-matched data).

### 🛠 CI

- **`Upgrade from npm-stable` job now runs `flair reembed` after upgrade**, mirroring the documented migration. Catches storage-format breakage at PR time instead of release-time.

- **`test/unit/federation-pair-role.test.ts` restores `globalThis.fetch` in `afterEach`** — the previous mock leaked into integration tests, masquerading as Harper-unhealthy timeouts when running the full suite.

## 0.7.0 (2026-05-03)

### 🛠 Chores

- **`@tpsdev-ai/openclaw-flair` v0.7.1** — Compiled `dist/` output for openclaw 2026.5.4+ compatibility. TypeScript plugins now require compiled runtime.

### ✨ Features

- **`@tpsdev-ai/openclaw-flair` now registers the `flair` context engine** for behavioral-anchor re-injection. On every turn, the engine reads `~/.openclaw/workspace-<agentId>/{IDENTITY,SOUL,AGENTS}.md` and returns their contents as a `systemPromptAddition` — pinning PERMANENT-tier rules at the top of the prompt so they don't drift across long sessions. Files are mtime-cached; missing files are skipped silently. Replaces the standalone `flair-context-engine` plugin (now retired) — anchor re-injection was the only feature that earned its slot per the audit; compaction-extract regex (0% retrieval), auto-ingest (dead path), and HEARTBEAT_OK filter (redundant with openclaw's built-in) were dropped.

### ✨ UX

- **`flair init` and CLI fetches no longer require `--admin-pass` for local instances with `authorizeLocal: true`**: when targeting localhost (no `--target`/`FLAIR_TARGET`), the CLI now skips Basic auth and lets Harper's `authorizeLocal` trust loopback requests. Remote targets still require `--admin-pass`. Sherlock-approved with a defense-in-depth follow-up noted on the auth-middleware locality guard.

### ⚠️ Behavioral Change

- **Local CLI fetches now ignore `FLAIR_ADMIN_PASS` / `HDB_ADMIN_PASSWORD`** when the target is localhost. Previously, setting either of these envs would force Basic auth even on local targets. If your local Flair has `authorizeLocal: false` (the deprecated default in some setups), local CLI calls will now 401; either flip `authorizeLocal: true` in `~/.flair/config.yaml` or use `FLAIR_TOKEN` / Ed25519 agent auth instead. Remote targets are unaffected — `--admin-pass` continues to work as before.

## 0.6.3 (2026-04-26)

### 🐛 Bug Fixes

- **`flair reembed` now includes `agentId` in update payload (Bug 6):** fixes regression where reembed always returned 0 updates due to missing required field. The payload now includes `agentId: memory.agentId || opts.agent` to satisfy the 0.5.5 schema-validation gate. Regression test added.

- **`flair reembed --agent` is now optional (Bug 3):** defaults to "all agents with stale rows on this instance" when omitted. Requires `FLAIR_ADMIN_PASS` for multi-agent access. The `flair status` warning's recommended command (`flair reembed --stale-only --dry-run`) now works as-emitted.

- **`flair status` shows all agents with writes (Bug 1):** previously only showed the authenticated agent. Now renders a row for every agent that has at least one memory on this instance, even for non-admin callers. Respects the localhost trust boundary — read-only public fields only.

- **`flair agent list` allows localhost operator access (Bug 2):** no longer requires per-agent auth when run from the same host. Treats localhost as a trusted boundary for IDs-only enumeration (no secrets, no key material, no memory contents). Falls back to agent auth if `FLAIR_AGENT_ID` is set.

- **`flair status --agent <id>` scopes warnings per-agent (Bug 4):** hash-fallback warnings now reflect only the filtered agent's data. Fleet-wide warnings (mixed models, federation, REM) are preserved. If flint has 0 hash-fallback, no warning appears when filtering to flint.

- **Federation summary agrees with subcommand (Bug 5):** both `flair status` and `flair status federation` now say "Federation: not configured" when federation is null. Previously the summary invented peer counts from OAuth principals.

### ✨ UX

- **Bridges summary matches subcommand:** `flair status` now prints "Bridges: none installed" when no bridges are present, matching `flair status bridges`.

### 🔒 Security

- **Localhost trust boundary for `flair agent list`:** IDs-only enumeration is allowed from localhost processes without per-agent Ed25519 auth. The response is filtered to public metadata (id, name, createdAt) — no secrets, no key material, no memory contents. Approved by Sherlock's security review.

- **Reembed respects cross-agent isolation:** the `agentId` passed in the update payload matches the record being reembedded, not a wildcard. The 0.5.5 schema-validation gate remains intact. Approved by Sherlock's security review.


### 📖 Docs

- **`docs/mcp-clients.md` (#286)** — one page covering wiring the [`@tpsdev-ai/flair-mcp`](packages/flair-mcp) server into Claude Code, Gemini CLI, OpenAI Codex CLI, and Cursor. Per-CLI install snippets, env-var reference, troubleshooting. Closes the "we have an MCP server but no per-framework setup docs" gap.

- **`docs/secrets-and-keys.md` (#287)** — draws the line between what Flair owns (Ed25519 agent identity) and what it doesn't (LLM provider API keys, third-party tokens). Patterns for OS keyring (macOS Keychain, Linux secret-service), 1Password CLI (`op run`), age + sops. Per-CLI examples for wiring API keys into Claude Code / Gemini CLI / Codex CLI / Hermes without leaking into shell history. Decision recorded inline: **no `flair secret` CLI in 1.0** — OS primitives are sufficient, adding a wrapper would be unowned bug surface.

- **`docs/the-team.md` (#288)** — public reference implementation of how LifestyleLab runs the multi-agent team that builds Flair. Roster (Flint / Anvil / Kern / Sherlock / Pulse + Nathan), memory-flow diagram showing per-agent isolation, why we split runtimes / hardware tiers / API-vs-local, the standard PR handoff loop, and what we deliberately don't do (no shared team memory, no silent extraction). Becomes the operator-facing pattern for "copy this rig if you're trying to run your own."

### 🔌 Plugin

- **`packages/hermes-flair/` (#285)** — Python `MemoryProvider` implementation of [Nous Research Hermes](https://github.com/NousResearch/hermes-agent)'s plugin contract. Makes Flair the durable memory backend for Hermes agents: bootstrap injection at session start, background prefetch between turns, two tools (`flair_search`, `flair_store`), built-in MEMORY.md mirroring, circuit breaker. TPS-Ed25519 auth with per-agent isolation enforced server-side. 23 unit tests pass with stubbed Hermes-side imports. First of several agent-framework integrations landing for 1.0; the others (Claude Code, Gemini CLI, OpenAI Codex CLI) all use the existing [`@tpsdev-ai/flair-mcp`](packages/flair-mcp) server (one MCP server, three install snippets) rather than per-framework adapters.

## 0.6.2 (2026-04-25)

### 🔒 Security

- **Bridge allow-list now pins approvals to package location + content digest (#283):** prior to this fix, `flair bridge allow <name>` stored only the short name. That left a local-squatting attack surface — a user who approved `mem0` in ProjectA could then `cd` into ProjectB shipping a planted `node_modules/flair-bridge-mem0` with the same npm name but different code, and the allow-list would happily pass it through to dynamic import. Approvals now record the canonical package directory and a sha256 of the package's `package.json`; at load time, both must still match the discovered package. Any mismatch refuses the load with a specific `path-mismatch` / `digest-mismatch` hint pointing back at `flair bridge allow <name>` for a deliberate re-approval. Legacy name-only entries from 0.6.0/0.6.1 are treated as invalid — operators must re-approve once. Reported by tps-sherlock on retroactive review of #282.

### ✨ UX

- **Operator-facing trust-error UX:** path-mismatch / digest-mismatch / not-allowed each render as a framed banner with operator-voice explanation, structured before/after values (approved location vs observed, approved digest vs observed), and the exact `flair bridge allow <name>` re-approve command. Replaces the spec-§10 JSON dump that was useful for descriptor-parse errors but buried the actionable command for trust events.

## 0.6.1 (2026-04-24)

### ✨ Features

- **Memory Bridges — slice 3b: round-trip test harness (#281):** `flair bridge test` runs a fixture-to-fixture round-trip — parse a fixture file with the bridge's import map, filter by `when:` predicates, write via the bridge's export map, re-parse the output, and diff stable fields (content/subject/tags/durability). Single command verifies a bridge correctly preserves the data it claims to bridge.

### 🐛 Bug Fixes

- **`flair upgrade` detects installs outside the default npm prefix (#279):** now uses `execFileSync` with explicit argv (closes a CodeQL "uncontrolled command line" finding) and splits status into three states — current / outdated / unknown-prefix. Previously crashed on mise/fnm/nvm/volta setups whose npm-prefix probe returned a non-default location.

## 0.6.0 (2026-04-22)

### ✨ Features

- **Memory Bridges — slice 1 (#268):** a new plugin system for importing and exporting memories between Flair and foreign memory formats (agentic-stack, Mem0, Letta, Anthropic memory, etc.). Two shapes — a YAML descriptor for file-format targets or a TypeScript code plugin for API targets — and a scaffold + round-trip test loop that lets an agent ship a working adapter in one pass. This slice ships the agent-facing surface: types, discovery across four sources (built-ins, `.flair-bridge/*.yaml`, `~/.flair/bridges/*.yaml`, `flair-bridge-*` npm packages), and the `flair bridge scaffold` / `flair bridge list` commands. The runtime (`test`, `import`, `export`) lands in slice 2. See [docs/bridges.md](docs/bridges.md) and [specs/FLAIR-BRIDGES.md](specs/FLAIR-BRIDGES.md).

- **First-run soul wizard (#265):** `flair init` now opens a template picker — **(1)** Solo developer, **(2)** Team agent in a shared repo, **(3)** Research assistant, **(4)** Draft from Claude (paste a Claude-generated JSON), **(5)** Custom with inline examples, or **(s)** Skip. Each template seeds concrete `role` / `project` / `standards` entries the user can edit inline. Previously the wizard asked three bare prompts with a single terse example each — unanswerable without context about what the fields affected downstream. First-impression UX on every fresh-machine install.

- **Status health tiering + embedding-model breakdown (#266):** `flair status` now reports tiered health — 🟢 clean / 🟡 warnings / 🔴 unreachable. New `Embeddings:` line groups by model name, surfacing mixed vector spaces that cross-model search can't handle. `HealthDetail` adds `memories.modelCounts`. New warning when hash-fallback exceeds 10% of total memories (was previously only flagged above 50%); new warning when multiple non-hash embedding models are present.

- **Hash-fallback memory inspector (#266):** `flair memory list --agent <id> --hash-fallback` renders a table of memories without a real embedding — useful for triaging which entries to re-embed with `flair reembed --stale-only`.

- **Per-agent coverage columns in status (#267):** the `Agents` table in `flair status` gains `hash_fb` (count of this agent's memories without real embeddings) and `24h` (writes in the last 24 hours) columns. Surfaces which agents are carrying the embedding-coverage burden and which are actively writing. Falls back gracefully to the pre-0.6.0 columns when pointed at an older server.

### 🐛 Bug Fixes

- **Status header "running" stays stable across health tiers (#270):** the initial 0.6.0 status-tiering change switched the header state word from `"running"` to `"degraded"` on warnings. This broke the `Upgrade from npm-stable` CI smoke, which greps for `running` to confirm the process is alive post-upgrade. Fix: decouple process-state (`running` / unreachable) from health (🟢 / 🟡 / 🔴). State word stays `"running"` whenever the process is alive; icon alone conveys health tier. Also the cleaner semantic split.

### 📖 Docs

- **New `CONTRIBUTING.md` (#271)** — entry points by audience, local setup, PR expectations, two-phase release process, pointer to bridges authoring.
- **New `docs/bridges.md` (#271)** — user-facing guide for the memory-bridges feature. Includes a one-shot prompt an agent can paste to ship a bridge from the doc alone.
- **README** — Memory Bridges added to the Features list with a link to the new doc.

### 🧹 Cleanup
- **Removed `flair migrate-keys`:** the `~/.tps/secrets/flair/` layout only existed while Flair lived in the TPS monorepo pre-0.1. No published user ever had that path, so the CLI command was dead code from an external perspective. Anyone still sitting on the old layout can migrate manually: `mv ~/.tps/secrets/flair/<agent>-priv.key ~/.flair/keys/<agent>.key` (strip the `-priv` suffix) and run `flair doctor` to confirm.

### 🔌 Plugin
- **`@tpsdev-ai/openclaw-flair` 0.5.7 — surface memory search to the LLM (#264):** the plugin registered its semantic search tool as `memory_recall`, but OpenClaw's `coding` profile only allows `memory_search` and `memory_get` by canonical name; non-canonical memory tool names are filtered out of the agent's LLM-visible toolset. That left Pulse with only `memory_get` (fetch-by-id) and no way to semantically search its own Flair memory. Renamed to `memory_search` to match the canonical OpenClaw contract — now surfaces under the default `coding` profile with zero config. `memory_store` is still plugin-namespaced; README documents the `tools.alsoAllow: ["memory_store"]` config needed to surface it.

### ⚠ Behavior change worth calling out
- **`flair init --skip-soul` and non-TTY init paths no longer seed placeholder soul entries.** Pre-0.6.0 they seeded generic `role` / `personality` / `constraints` strings ("AI assistant [default — customize with 'flair soul set']") that leaked into bootstrap output and confused users. Those paths now leave the soul empty; `flair doctor` and the standard `flair soul set` flow nudge the operator to populate real entries.

## 0.5.6 (2026-04-17)

### 🐛 Bug Fixes
- **`flair grant` silently broken since 0.5.0:** the CLI inserted MemoryGrant records with fields `fromAgentId`/`toAgentId`, but the schema and all three readers (`Memory.ts`, `SemanticSearch.ts`, `auth-middleware.ts`) filter on `granteeId` / `ownerId`. Grants never expanded in search — a granted agent saw the same results as an ungranted one. Latent for four releases because the only existing test was a mock-server test that pinned the wrong field names. User-visible as of 0.5.5 because that release closed the body-`agentId` spoof path, making grants the *only* supported cross-agent read. CLI now writes `ownerId`/`granteeId`; integration test in `agent-journey.test.ts` exercises the full grant expansion end-to-end against a real Harper (#237).
- **`flair restart` dropped admin credentials:** `flair restart` only read `HDB_ADMIN_PASSWORD` from env; `flair start` already accepted either `HDB_ADMIN_PASSWORD` *or* `FLAIR_ADMIN_PASS`. A shell exporting only `FLAIR_ADMIN_PASS` (the CLI-side env name the `api()` helper checks) would restart Harper without admin creds — subsequent authenticated calls returned 401, but `flair status` still reported "running" because `/Health` treats a 401-on-up response as healthy. Aligned restart's env resolution with start; skip setting `HDB_ADMIN_PASSWORD=""` when unset, to avoid stripping auth on an existing install (#238).

### 🔧 Infrastructure
- **Pack-smoke daemon round-trip:** the install-from-tarball CI job now does a full `memory add` → `memory search` round-trip against the installed tarball. Catches 0.5.2-class regressions (scoped search returning 0 rows) at packaging time rather than integration time, and surfaced both of the bug fixes above during its first run (#238).

---

## 0.5.5 (2026-04-17)

### 🔒 Security
- **Cross-agent memory isolation break on `/SemanticSearch`, `/BootstrapMemories`, `/ReflectMemories`, `/ConsolidateMemories` (P0):** a non-admin agent could read (and in `/ReflectMemories`' case, mutate) another agent's memories by putting the victim's id in the request body. The signature check verified the caller's identity correctly, but each of these endpoints scoped the search by the *body-supplied* `agentId` and performed a defense-in-depth check against `(this as any).request?.headers?.get("x-tps-agent")`. `this.request` is never populated on Harper v5 `Resource` subclasses, so the comparison silently returned `undefined !== undefined` (falsy) and the check was a no-op. `Memory.search` was unaffected because it uses `getContext().request` — the correct pattern. All four endpoints now read the authenticated identity from `getContext().request` and pin the effective `agentId` to the authenticated agent for non-admins; body `agentId` mismatches return 403. Regression test in `test/integration/agent-journey.test.ts` seeds two Ed25519 agents, writes 50 memories as alice, and asserts bob cannot exfiltrate them via any of the four endpoints.

---

## 0.5.4 (2026-04-17)

### 🐛 Bug Fixes
- **`flair restart` race (macOS launchd):** `flair restart` printed `✅ Flair restarted` before Harper was actually reachable, so an immediately following `flair status` could report `🔴 unreachable` for a brief window. Two bugs: (1) `waitForHealth` accepted *any* HTTP response (`res.status > 0` is always true), so it returned success against the still-shutting-down old process, and (2) on the launchd path we never confirmed the old process exited before polling, letting us race past the shutdown→KeepAlive→respawn gap. Now we read `hdb.pid` before `launchctl stop`, wait for that PID to actually exit, then poll `/Health` for 2xx (or 401 — server up, auth issue). Also aligned the health path on `/Health` (capital H) to match `flair status`.

---

## 0.5.3 (2026-04-17)

### 🐛 Bug Fixes
- **CLI packaging (P0):** `flair` CLI threw `ERR_MODULE_NOT_FOUND` on any installed version >= 0.5.0 because `dist/cli.js` imported `../resources/federation-crypto.js`, which resolved to `<pkg>/resources/…` at install time — a path outside the published `files` manifest. Inlined the two tiny pure-fn helpers (`canonicalize`, `signBody`) directly into `src/cli.ts` so there are no cross-boundary imports from `src/` into `resources/`. Added a CI job that packs the tarball, installs it into a clean project, and runs `flair --version` so this can't silently re-break.

---

## 0.5.2 (2026-04-16)

### 🐛 Bug Fixes
- **Agent-scoped memory search (P0):** scoped `Memory.search` and `SemanticSearch` returned 0 rows for authenticated agents despite data existing and the `agentId` index being healthy. Root cause is in Harper's `txnForContext` chain: when a request reads two tables sequentially, the first generator leaves its transaction CLOSED and the second inherits that state. Workaround applied at the Memory call sites via a `withDetachedTxn` helper that detaches the context for the inner call. Will file upstream with a minimal repro. (#229)

### 🔒 Security
- **`Memory.put` `_reindex` escape hatch gated on admin:** the `_reindex=true` flag used by `MemoryReindex` was reachable by any authenticated agent on a raw PUT, bypassing content-safety scan, embedding regeneration, and `updatedAt` tracking. Now mirrors the admin-check pattern from `Memory.delete`. (#229)

### 🛠 Internal
- **`MemoryReindex` admin endpoint:** dormant repair tool to re-PUT records when Harper's secondary-index backfill is incomplete. Unused today (index was healthy in the reported regression) but kept for future recovery. (#229)

---

## 0.5.1 (2026-04-16)

### 🐛 Bug Fixes
- **`flair status` auth:** retries with admin credentials when Harper returns 401 (`authorizeLocal: true` instances)
- **CI:** Docker image updated to Harper 5.0.0 stable, native embedding binary + model pre-installed, `continue-on-error` removed

---

## 0.5.0 (2026-04-15)

### 🚀 Features

**Identity & Access Control**
- **Principal model:** trust-tiered identity with human/agent kinds, credential management, admin controls (#208)
- **OAuth 2.1 server:** authorization code flow with PKCE, dynamic client registration, token endpoint (#209)
- **XAA (Enterprise-Managed Authorization):** IdP-based access control via jwt-bearer grant, supports Google Workspace, Azure AD/Entra, Okta/Auth0 (#211)
- **Web admin UI:** server-rendered HTML pages for managing principals, connectors, IdPs, instance config, memory, and relationships (#212)

**Memory**
- **Temporal validity:** `validFrom`/`validTo` on memories with auto-close when superseded (#205)
- **Relationship table:** entity-to-entity triples (subject/predicate/object) with temporal bounds and confidence (#205)
- **Predictive bootstrap:** accepts `channel`, `surface`, `subjects` context signals to preload relevant memories and relationships (#206)
- **Auto entity detection:** passive extraction of people, tools, projects from memory content during writes (#207)

**Federation**
- **Hub-and-spoke sync:** push/pull record synchronization between Flair instances (#213)
- **Signed sync protocol:** Ed25519 request signatures on all federation operations, verified against pinned peer keys (#213)
- **Encrypted keystore:** AES-256-GCM encrypted private key storage at `~/.flair/keys/`, auto-generated random passphrase (#213)
- **Pairing tokens:** one-time tokens for peer registration, TTL-limited, single-use (#213)
- **Originator enforcement:** spokes can only push records they originated, hubs can relay (#213)
- **Timestamp ceiling:** rejects records with `updatedAt` >5 minutes in the future (#213)
- **CLI:** `flair federation status`, `flair federation pair`, `flair federation sync`, `flair federation token` (#213)

**Infrastructure**
- **Harper 5.0.0 stable:** upgraded from beta.8, VM module loader fix for native plugin imports (#204)

### 🐛 Bug Fixes
- **Stored XSS in web admin:** all dynamic content escaped via `esc()` helper (#212)
- **OAuth open redirect:** CSRF with arbitrary redirect_uri blocked (#209)
- **JWT signature verification:** jose `jwtVerify` with proper algorithm pinning (#211)
- **GCM auth tag length:** explicit `authTagLength: 16` on decipher for Semgrep compliance (#213)
- **Keystore fail-closed:** refuses to create federation identity without secure key storage (#213)

### 📖 Documentation
- **CHANGELOG:** updated through 0.5.0

### 🔧 Infrastructure
- **9 CI checks per commit:** unit tests, integration tests, type check, dep audit, Semgrep SAST, CodeQL SAST, Socket supply chain, Docker from-scratch
- **13 federation security tests:** canonicalization, sign/verify, tamper detection, keystore encryption

### 📦 Packages
- `@tpsdev-ai/flair` 0.5.0
- `@tpsdev-ai/flair-client` 0.5.0
- `@tpsdev-ai/flair-mcp` 0.5.0
- `@tpsdev-ai/openclaw-flair` 0.5.0

---

## 0.4.16 (2026-04-05)

### 🚀 Features
- **Rich `flair status`:** shows PID, uptime, port, embeddings mode, agent count, memory stats (#197)
- **`flair upgrade`:** checks npm for newer versions, shows actionable upgrade commands (#197)
- **`flair start`:** dedicated start command with foreground mode (#196)
- **Launchd plist generation:** `flair init` on macOS automatically registers a launchd service (#195)
- **Release script:** `scripts/release.sh` for aligned multi-package publishing (#199)

### 🐛 Bug Fixes
- **Content safety in search:** flagged memories now wrapped in `[SAFETY]` delimiters in SemanticSearch results, matching bootstrap behavior (#198)
- **`_safetyFlags` schema:** added to Memory GraphQL type (was stored dynamically) (#198)
- **Unified port resolution:** all CLI commands now consistently resolve port from `--port` flag > `FLAIR_URL` env > `config.yaml` > default (#195)
- **Doctor port discovery:** detects port mismatches via PID-based process inspection (#192)
- **Config file format:** supports both `config.yml` and `config.yaml` (#191)
- **OpenClaw plugin:** updated default port from 9926 to 19926, bumped flair-client dep to 0.4.3 (#202)
- **Dedup scoring:** use raw semantic scores for deduplication, not composite scores
- **Memory IDs:** use `crypto.randomUUID` for collision-free ID generation
- **MCP params:** coerce string-to-number for tool parameters (Cursor compatibility)
- **Soul scoping:** enforce agentId on soul operations
- **Auth middleware:** removed broken `request.clone().json()` calls
- **Uninstall:** now kills Harper process on all platforms
- **Init:** skip redundant Harper install when data dir already exists
- **Init:** isolate HOME override to install subprocess only

### 📖 Documentation
- **Deployment guide:** macOS, Linux, Docker, remote access, config reference (`docs/deployment.md`)
- **Upgrade guide:** standard upgrade, re-embedding, rollback (`docs/upgrade.md`)
- **Troubleshooting guide:** common issues with `flair doctor` integration (`docs/troubleshooting.md`)
- **OpenClaw guide:** plugin setup, multi-agent, soul, key resolution (`docs/openclaw.md`)
- **Test coverage matrix:** 212 tests across 19 files, organized by security category in README
- **CI badges:** Docker from-scratch test badge added to README

### 🔧 Infrastructure
- **Harper v5.0.0-beta.8:** upgraded from beta.7
- **7 CI checks per commit:** unit tests, integration tests, type check, dep audit, Semgrep SAST, CodeQL SAST, Docker from-scratch
- **Docker test:** installs `@node-llama-cpp/linux-x64` for embedding validation (#194)

### 📦 Packages
- `@tpsdev-ai/flair` 0.4.16
- `@tpsdev-ai/flair-client` 0.4.3
- `@tpsdev-ai/flair-mcp` 0.4.4
- `@tpsdev-ai/openclaw-flair` 0.4.1

---

## 0.4.0 (2026-04-01)

### 🚀 Features
- **Lifecycle commands:** `flair stop`, `flair restart`, `flair uninstall` (#150, #151)
- **Content safety filtering:** pattern-based prompt injection detection on memory writes (#153)
- **Rate limiting:** per-agent sliding window rate limiter for public deployments (#154)
- **Embedding model tracking:** `embeddingModel` field stamped on writes, `flair reembed` CLI command (#166)
- **Standalone auth mode:** Basic auth fallback in flair-client for deployments without Ed25519 keys (#180)
- **Conflict-free default ports:** 9926/9925 → 19926/19925 to avoid Harper collisions

### 🐛 Bug Fixes
- **Fresh Linux install:** `flair init` now works on completely fresh machines (#181, #184)
- **Production mode search:** Fixed 3 bugs preventing semantic search on remote VMs (#183, #182)
  - `__dirname` undefined in Harper VM sandbox → use `process.cwd()`
  - `Memory.put()` missing `archived:false` default
  - `getMode()` gate blocking embedding initialization
- **Query truncation:** Increased from 500 to 8000 chars to match nomic-embed context window (#164)
- **Embedding fallback:** Removed dead hash-based fallback, added degradation observability (#165)
- **Docker test:** Fixed step 6 port mismatch (#177, #178)
- **Archived filter:** Use `not_equal` comparator (Harper v5 compatible)

### 🔧 Infrastructure
- **Harper v5.0.0-beta.7:** Upgraded from beta.4 with launchd admin password injection (#167)
- **Production auth:** `request.user` set directly via `server.getUser()` for Harper table access
- **Auth middleware:** Proper Basic auth swap for HNSW vector search compatibility

### 📦 Packages
- `@tpsdev-ai/flair` 0.4.0
- `@tpsdev-ai/flair-client` 0.4.0 (standalone auth, port defaults)
- `@tpsdev-ai/flair-mcp` 0.4.0 (port defaults, auth docs)
