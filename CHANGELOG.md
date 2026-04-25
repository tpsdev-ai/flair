# Changelog

## Unreleased

### 📖 Docs

- **`docs/mcp-clients.md` (#286)** — one page covering wiring the [`@tpsdev-ai/flair-mcp`](packages/flair-mcp) server into Claude Code, Gemini CLI, OpenAI Codex CLI, and Cursor. Per-CLI install snippets, env-var reference, troubleshooting. Closes the "we have an MCP server but no per-framework setup docs" gap.

- **`docs/secrets-and-keys.md` (#287)** — draws the line between what Flair owns (Ed25519 agent identity) and what it doesn't (LLM provider API keys, third-party tokens). Patterns for OS keyring (macOS Keychain, Linux secret-service), 1Password CLI (`op run`), age + sops. Per-CLI examples for wiring API keys into Claude Code / Gemini CLI / Codex CLI / Hermes without leaking into shell history. Decision recorded inline: **no `flair secret` CLI in 1.0** — OS primitives are sufficient, adding a wrapper would be unowned bug surface.

- **`docs/the-team.md` (#288)** — public reference implementation of how LifestyleLab runs the multi-agent team that builds Flair. Roster (Flint / Anvil / Kern / Sherlock / Pulse + Nathan), memory-flow diagram showing per-agent isolation, why we split runtimes / hardware tiers / API-vs-local, the standard PR handoff loop, and what we deliberately don't do (no shared team memory, no silent extraction). Becomes the operator-facing pattern for "copy this rig if you're trying to run your own."

### 🔌 Plugin

- **`plugins/hermes-flair/` (#285)** — Python `MemoryProvider` implementation of [Nous Research Hermes](https://github.com/NousResearch/hermes-agent)'s plugin contract. Makes Flair the durable memory backend for Hermes agents: bootstrap injection at session start, background prefetch between turns, two tools (`flair_search`, `flair_store`), built-in MEMORY.md mirroring, circuit breaker. TPS-Ed25519 auth with per-agent isolation enforced server-side. 23 unit tests pass with stubbed Hermes-side imports. First of several agent-framework integrations landing for 1.0; the others (Claude Code, Gemini CLI, OpenAI Codex CLI) all use the existing [`@tpsdev-ai/flair-mcp`](packages/flair-mcp) server (one MCP server, three install snippets) rather than per-framework adapters.

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
