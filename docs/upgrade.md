# Upgrade Guide

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
# Install the previous version
npm install -g @tpsdev-ai/flair@0.4.16

# Restart
flair restart

# If data is corrupted, restore from backup
flair restore < ~/flair-backup-20260405.json
```
