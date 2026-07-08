# Changelog

## [Unreleased]

The upgrade path becomes one tested transaction — install, restart, verify, and roll back automatically on failure — backed by a pre-upgrade data snapshot, a nightly-checked downgrade path, and a post-deploy fleet-convergence sweep. Also closes out the remaining `authorizeLocal`-class security gaps from the 0.21.0 state review.

### 🔁 `flair upgrade` restarts by default, verifies, and rolls back (#635, #641)

Upgrade is now one transaction: install → restart → verify → rollback-on-failure, instead of leaving the OLD process serving while the version on disk lied about what was actually running. Restart-after-install is the new default (`--no-restart` opts out; the old `--restart` flag is a deprecated no-op). After restart, `probeInstance` confirms `/Health`, an authenticated round-trip, and that the reported running version matches what was just installed (`--no-verify` to skip). On verification failure, `flair upgrade` reinstalls the previously-running version, restarts, and re-verifies — and if that rollback also fails to verify, it points at the pre-upgrade snapshot instead of looping.

### 📸 Pre-upgrade data snapshot + tested downgrade path (#637, #647)

`flair upgrade` now snapshots `~/.flair/data` to `~/.flair/upgrade-snapshots/` (timestamped tar.gz, exact file modes preserved, keep-last-3 retention) before touching any package — quiescing Flair first, since a live RocksDB directory mid-compaction isn't safe to copy. A snapshot failure aborts the upgrade before any package changes. `docs/upgrade.md` gains a full [Downgrade](docs/upgrade.md#downgrade) procedure, and a nightly compat test (`test/compat/downgrade-boot.test.ts`) actually boots the last npm-published release against newer data and confirms it reads back cleanly — replacing the old "not a tested path" language with an honest, continuously-checked claim.

### 🚦 `flair fleet verify` — post-deploy convergence sweep (#636, #642)

Fabric deploys tolerate replication errors by design (origin-first), but nothing previously confirmed peers actually converged — the 0.21.0 deploy shipped with a peer still throwing 1006s while the CLI reported success. New standalone `flair fleet verify --target <url>` sweeps the origin + every known Flair federation peer, prints a per-node table, and exits 0 (all verified) / 1 (origin failed) / 2 (peer version skew) / 3 (peer unreachable/unverifiable). Wired automatically into `flair deploy` and `flair upgrade --target` post-success (`--no-fleet-verify` to skip). Explicitly scoped to Flair's own federation peers, not Harper's own cluster-replication nodes (`cluster_status` is harper-pro-only and unavailable to this build).

### 🔑 CLI sends real local credentials instead of riding `authorizeLocal` (#634, #640)

`api()` previously sent no `Authorization` header for local targets, relying on Harper's `authorizeLocal` to forge a `super_user` for credential-less loopback requests — a gap the #632 security fix below closed, which meant credential-less local calls like `flair federation status` started getting a real 403. Fixed: local targets now resolve real credentials in precedence order `FLAIR_TOKEN` > `FLAIR_ADMIN_PASS`/`HDB_ADMIN_PASSWORD` > agent Ed25519 key > the `~/.flair/admin-pass` file `flair init` writes. A 403 with no credentials now throws a clear, actionable message instead of a raw "forbidden" body.

### 🛰️ Version-stamped presence + fleet staleness in `doctor` (#639, #645)

`POST /Presence` now stamps the serving instance's running `flairVersion` + `harperVersion` on every heartbeat, gated behind the same verified-agent read as `currentTask`. `flair doctor` gets a new "Fleet presence" section listing known instances oldest-version-first and flagging any behind the newest version seen across the roster (org-relative, not npm-latest). Note: Presence doesn't currently participate in federation sync, so on a hub+spokes deployment this only reports the querying instance's own directly-heartbeating agents.

### 🧪 Mixed-version federation compat CI (#638, #644)

A nightly + PR-triggered suite spawns the last published `@tpsdev-ai/flair` alongside the current build as two independent Harper instances, pairs them reciprocally, and drives a real federation round-trip through each side's own CLI. Surfaced two orthogonal version-skew findings along the way (documented inline, not fixed there): the published baseline predates #634's local-credential fix and predates the `authorizeLocal`-forged-`super_user` hardening on `/FederationInstance`.

### 🔒 Security

- **Gate `FederationInstance`/`FederationPeers`/`HealthDetail`/`SkillScan` — `authorizeLocal` class (#632, closes #631)** — the #614/#630 CI backstop surfaced four resources with no explicit allow-decision, falling through to Harper's default `super_user` check, satisfiable by `authorizeLocal`'s forged loopback super_user. `FederationInstance`/`FederationPeers` now require admin; `HealthDetail` requires a verified caller (and fixes a backwards `isAdmin` default that treated an unresolved caller as admin); `SkillScan` requires a verified caller.

### 🧹 Tooling / CI / hygiene

- **Assert every Resource declares an explicit allow-decision (#630, closes #614)** — a repo-wide backstop that enumerates every `resources/*.ts` and fails when a new one ships with no allow-decision; found the four gaps closed by #632 above.
- **Wire the remaining 5 packages' tests into CI (#633, closes #619)** — `flair-client`, `langgraph-flair`, `n8n-nodes-flair`, `openclaw-flair`, `pi-flair` had real test suites CI only typechecked, never ran.
- **Fix port drift + stale security-model docs + `upgrade.md` (#629)** — standardized docs on the real `19926` default, corrected security-model docs still describing the retired grant-gated read model, unfroze `upgrade.md` from a pinned old version.
- **Name the real storage engine — Harper 5.x is RocksDB, not LMDB (#648)** — corrects the #647 snapshot-consistency rationale, which cited the wrong engine (LMDB is what Harper ≤4 used, and remains in the dependency tree, which is where the mislabel came from). The quiesce-before-snapshot design itself is unchanged.
- **Bump `@harperfast/harper` 5.1.15 → 5.1.17 (#607)** — patch bump: replication 503-vs-404 reliability, Docker entrypoint fix, npm-shrinkwrap packaging, MQTT shared-port. No Flair code change needed.

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
