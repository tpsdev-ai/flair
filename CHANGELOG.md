# Changelog

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
