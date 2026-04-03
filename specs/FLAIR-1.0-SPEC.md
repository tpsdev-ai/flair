# Flair 1.0 Product Spec

## Status
- **Owner:** Flint
- **Priority:** P0 — Only priority for April 2026
- **Target:** Flair feels like a finished product a stranger can adopt

## Definition of 1.0

Flair 1.0 means: install in one command, run for 30 days without touching it, check status in 2 seconds, and any MCP-compatible agent gets memory/identity/soul with zero custom code.

---

## 1. Zero-Config Install

### `flair init`
- Single command → working instance
- Auto-detects platform (macOS/Linux)
- Installs Harper, downloads nomic-embed-text model, creates database
- Sets up launchd (macOS) or systemd (Linux) for auto-start on boot
- Generates a default admin identity
- Health check passes before the command exits
- **Target:** Under 60 seconds on a Mac Mini with decent internet

### What must work after `flair init`:
- `flair status` → green
- `flair agent add mybot` → identity created
- `flair memory add --agent mybot --content "test"` → stored with real embeddings
- `flair memory search --agent mybot --q "test"` → returns the memory with semantic score

---

## 2. MCP Server (`@tpsdev-ai/flair-mcp`)

### Install & Run
```bash
npx @tpsdev-ai/flair-mcp
```

### Tools (minimum set for 1.0)
| Tool | Description |
|------|-------------|
| `memory_search` | Semantic search over agent memories |
| `memory_store` | Write a new memory (with auto-embedding) |
| `memory_get` | Retrieve a specific memory by ID |
| `bootstrap` | Cold-start context assembly (soul + recent + relevant) |
| `soul_get` | Read soul entries |
| `soul_set` | Write/update soul entries |

### Requirements
- Works with Claude Code, Cursor, Windsurf, Open WebUI via standard MCP config
- Local-trust mode (no Ed25519 required for localhost connections)
- Env vars: `FLAIR_URL` (default localhost), `FLAIR_AGENT_ID` (required)
- Package name: `@tpsdev-ai/flair-mcp` (rename from current `@tpsdev-ai/mcp-server`)

---

## 3. OpenClaw Plugin (`@tpsdev-ai/openclaw-flair`)

### Install
```bash
openclaw plugins install @tpsdev-ai/openclaw-flair
```

### Must work:
- Auto-detects agent identity from OpenClaw config
- Provides `memory_store`, `memory_recall`, `memory_get` tools
- Injects relevant memories at session start (bootstrap)
- Soul entries persist across compaction/restart

---

## 4. Lifecycle Resilience

### Machine Restart
- Flair auto-starts via launchd/systemd after reboot
- No stale PID files, no port conflicts
- Embeddings model loads cleanly on restart
- First agent request after restart works (no warm-up failures)

### `flair status`
One command, full picture:
```
Flair v0.4.0 — RUNNING (PID 12345, uptime 14d 3h)
  Port:       19926
  Embeddings: nomic-embed-text v1.5 (Metal, 768 dims)
  Memories:   1,247 total (1,198 with embeddings, 49 hash-fallback)
  Agents:     3 registered (flint, anvil, sherlock)
  Last write: 2m ago (flint)
  Last search: 45s ago (anvil)
  Disk:       284 MB
  Health:     ✅ All checks passing
```

### `flair doctor`
Diagnoses common problems:
- Port in use by another process?
- Embedding model file missing or corrupt?
- Harper process alive but health endpoint dead?
- Keys directory missing or permissions wrong?
- Stale PID file blocking startup?
- Database needs migration?
- Any memories stuck on hash-fallback that should be re-embedded?

Output: problem description + fix command for each issue found.

### `flair upgrade`
- Downloads new version
- Runs schema migrations if needed
- Re-embeds memories if embedding model changed
- Rolls back on failure
- Zero-downtime if possible (restart Harper after migration)

---

## 5. Embeddings Quality Gate

### Must be true for 1.0:
- Default embedding mode is nomic-embed-text on Metal (macOS) or CPU (Linux)
- Hash-fallback (512-dim) is a **warning state**, not silent
- `flair status` shows embedding mode prominently
- `flair doctor` flags hash-fallback memories and offers `flair reembed` to fix them
- Semantic search on hash-fallback returns a warning in results

---

## 6. Documentation

### README.md
- Quick start: install → first memory → first search in under 5 minutes
- Integration guides: Claude Code, OpenClaw, Cursor, raw HTTP
- Architecture diagram
- Already mostly done — needs polish and testing by a fresh pair of eyes

### Guides needed:
- `docs/claude-code.md` — step-by-step MCP setup
- `docs/openclaw.md` — plugin setup and configuration
- `docs/deployment.md` — production deployment (macOS, Linux, Docker)
- `docs/upgrade.md` — version upgrade procedures
- `docs/troubleshooting.md` — common issues and fixes (flair doctor output explained)

---

## 7. Testing

### Integration tests:
- `flair init` → `flair status` → green (clean machine test)
- Write memory → search memory → correct result (semantic, not keyword)
- Bootstrap returns soul + recent memories
- Machine restart → first request succeeds
- MCP server connects and all 6 tools work
- OpenClaw plugin installs and provides tools

### Security tests:
- Agent A cannot read Agent B's memories (isolation enforcement)
- Ed25519 auth rejects invalid/expired/replayed signatures
- Content safety scan blocks prompt injection attempts
- Permanent memories cannot be deleted by non-admin agents
- Rate limiter triggers correctly under burst load

### Performance benchmarks:
- 1,000 memories → search < 100ms
- 10,000 memories → search < 500ms
- 100,000 memories → search < 2s
- 5 concurrent agents writing → no corruption

### Stress tests:
- 30-day uptime simulation (Harper doesn't leak memory or degrade)
- Machine restart → first request succeeds within 10s of Harper starting

### Coverage as a product signal:
- Publish test count + coverage % in README
- Match Microsoft's Agent Governance Toolkit pattern: "covers X out of Y risks"
- CI badge showing passing tests on every commit

---

## Execution Plan

### Phase 1: Stabilize (This week)
- Fix port config (9926 vs 19926 drift)
- Fix health endpoint
- Fix Metal embeddings (no more hash fallback)
- Fix bootstrap reliability

### Phase 2: MCP Server (Next)
- Complete all 6 tools
- Rename package to `@tpsdev-ai/flair-mcp`
- Test with Claude Code end-to-end

### Phase 3: Lifecycle (Then)
- Implement `flair status` (rich output)
- Implement `flair doctor`
- Implement `flair upgrade`
- Harden launchd/systemd auto-restart

### Phase 4: Polish (Final)
- Documentation pass
- Fresh-machine install test
- OpenClaw plugin verification
- Publish to npm
