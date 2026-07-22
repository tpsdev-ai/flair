# Changelog

## [Unreleased]

### Fixed

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
