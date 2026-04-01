# Changelog

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
