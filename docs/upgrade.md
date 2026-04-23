# Upgrade Guide

## Upgrading to 0.6.0 (from 0.5.x)

### Behavior changes to know about

- **`flair init --skip-soul` and non-TTY init no longer seed placeholder soul entries.** Pre-0.6.0 those paths inserted generic `role` / `personality` / `constraints` strings (e.g. `"AI assistant [default — customize with 'flair soul set']"`). Those entries leaked into `flair bootstrap` output and confused users, so 0.6.0 leaves the soul empty for non-interactive installs. `flair doctor` and `flair soul set` are the nudge/workflow for populating real entries. **If you're upgrading an existing agent**: your previously-seeded placeholder entries are still there and won't be auto-removed. Run `flair soul list --agent <id>` to check; `flair soul delete` if you want them gone.

- **`flair status` header now tiers health.** 🟢 means healthy; 🟡 means the process is running but something's worth looking at (e.g. >10% of your memories are hash-fallback); 🔴 still means unreachable. The state word stays `"running"` for 🟢 and 🟡 — only the icon changes. Any `grep -q "running"` scripts you have against `flair status` output continue to work; scripts that checked for 🟢 specifically should switch to `grep -q "🟢"` or treat 🟡 as also healthy.

### New surfaces in 0.6.0

- **`flair status`** now shows an `Embeddings:` line breaking down memories by embedding model — useful for catching mixed vector spaces after an upstream model change.
- **`flair memory list --hash-fallback`** lists memories that lack a real embedding. Feeds a cleaner triage workflow when paired with `flair reembed --stale-only`.
- **Per-agent columns in `flair status`** — new `hash_fb` and `24h` columns show which agents are carrying the embedding-coverage burden and which are actively writing.
- **`flair bridge list` / `flair bridge scaffold`** — slice 1 of the memory-bridges plugin system. Runtime (`import`/`export`/`test`) lands in the next release. See [bridges.md](bridges.md).
- **Revamped `flair init` first-run wizard** — template picker with (1) Solo developer / (2) Team agent / (3) Research assistant / (4) Draft from Claude / (5) Custom / (s) Skip. Only affects fresh installs.

## Standard Upgrade

```bash
# 1. Backup (always)
flair backup > ~/flair-backup-$(date +%Y%m%d).json

# 2. Upgrade the package
npm install -g @tpsdev-ai/flair@latest

# 3. Restart
flair restart

# 4. Verify
flair status
flair doctor
```

`flair doctor` will flag any issues that need attention after an upgrade (stale embeddings, schema changes, etc.).

## Re-embedding

If the embedding model changes between versions, old memories may use a different embedding dimension. `flair doctor` will detect this:

```
⚠️  49 memories have hash-fallback embeddings (512-dim)
   Current model produces 768-dim vectors
   Run: flair reembed
```

Fix with:

```bash
flair reembed
```

This re-generates embeddings for all memories using the current model. Runs in the background — the server stays available during re-embedding.

## Version Compatibility

- **Data format:** Flair stores data in Harper's native format. Harper v5 beta releases maintain backward compatibility within the v5 line.
- **Keys:** Ed25519 keypairs are version-independent. No key migration needed between Flair versions.
- **Config:** `~/.flair/config.yaml` format is stable. New options use defaults if not present.

## MCP Server Upgrade

If you use the MCP server with Claude Code:

```bash
npm install -g @tpsdev-ai/flair-mcp@latest
```

Then restart Claude Code to pick up the new version. No config changes needed — the MCP server reads `FLAIR_URL` and `FLAIR_AGENT_ID` from environment.

## Rollback

If an upgrade causes issues:

```bash
# Install a specific previous version (substitute your last known-good)
npm install -g @tpsdev-ai/flair@0.5.6

# Restart
flair restart

# If data is corrupted, restore from backup
flair restore < ~/flair-backup-20260405.json
```

Data written by a newer Flair is readable by the immediate predecessor — there are no schema breaks within the 0.5.x → 0.6.x window. Downgrading further back than one minor version is unsupported; use the backup path instead.
