# Documentation TODO

## What exists
- [x] README.md — main overview, integration paths, architecture
- [x] SECURITY.md — threat model, auth protocol
- [x] docs/claude-code.md — Claude Code setup guide
- [x] packages/flair-client/README.md — JS/TS client API
- [x] packages/flair-mcp/README.md — MCP server setup
- [x] plugins/openclaw-flair/README.md — OpenClaw plugin

## What's missing

### Guides
- [ ] **Getting Started** — step-by-step for first-time users (install → init → first memory → first search)
- [ ] **Agent Identity** — how keys work, agent lifecycle (create, rotate, remove)
- [ ] **Memory Model** — durability tiers, types, dedup, temporal decay, search scoring
- [ ] **Soul** — what soul entries are, how they affect bootstrap, best practices
- [ ] **Multi-Agent** — grants, shared memory, team patterns
- [ ] **Deployment** — local vs remote vs Fabric, Harper config, production checklist
- [ ] **Backup & Restore** — single-agent export, full backup, git sync (after Phase 3)
- [ ] **Troubleshooting** — common errors, port issues, auth failures

### API Reference
- [ ] **HTTP API** — all endpoints, request/response formats, auth headers
- [ ] **CLI Reference** — all commands with examples (auto-generated from --help?)
- [ ] **MCP Tools** — tool schemas, parameter descriptions

### Integration Guides
- [ ] **Claude Code** — exists but needs update for auto-bootstrap CLAUDE.md
- [ ] **Codex** — .codex/instructions.md pattern
- [ ] **Cursor** — .cursor/settings.json MCP config
- [ ] **Custom Runtimes** — using flair-client directly

### Project
- [ ] **CHANGELOG** — version history with breaking changes
- [ ] **CONTRIBUTING** — how to contribute, dev setup, test commands
- [ ] **Architecture** — deep dive into Harper resources, auth middleware, embeddings
