# Changelog

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

- Smoke test scaffold + golden-path e2e scenario (#442) — closes ops-t0i3.
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

- **`@tpsdev-ai/openclaw-flair` now registers the `flair` context engine** for behavioral-anchor re-injection (ops-czop). On every turn, the engine reads `~/.openclaw/workspace-<agentId>/{IDENTITY,SOUL,AGENTS}.md` and returns their contents as a `systemPromptAddition` — pinning PERMANENT-tier rules at the top of the prompt so they don't drift across long sessions. Files are mtime-cached; missing files are skipped silently. Replaces the standalone `flair-context-engine` plugin (now retired) — anchor re-injection was the only feature that earned its slot per the audit; compaction-extract regex (0% retrieval), auto-ingest (dead path), and HEARTBEAT_OK filter (redundant with openclaw's built-in) were dropped.

### ✨ UX

- **`flair init` and CLI fetches no longer require `--admin-pass` for local instances with `authorizeLocal: true`** (ops-vu31): when targeting localhost (no `--target`/`FLAIR_TARGET`), the CLI now skips Basic auth and lets Harper's `authorizeLocal` trust loopback requests. Remote targets still require `--admin-pass`. Sherlock-approved with a defense-in-depth follow-up noted on the auth-middleware locality guard.

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

- **Localhost trust boundary for `flair agent list`:** IDs-only enumeration is allowed from localhost processes without per-agent Ed25519 auth. The response is filtered to public metadata (id, name, createdAt) — no secrets, no key material, no memory contents. Approved by Sherlock in ops-fqwh review.

- **Reembed respects cross-agent isolation:** the `agentId` passed in the update payload matches the record being reembedded, not a wildcard. The 0.5.5 schema-validation gate remains intact. Approved by Sherlock in ops-fqwh review.


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
