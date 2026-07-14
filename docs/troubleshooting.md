# Troubleshooting

Start with `flair doctor` — it diagnoses most common issues automatically.

```bash
flair doctor
```

## Common Issues

### "Harper is not running"

**Symptoms:** `flair status` shows not running, bootstrap fails.

**Fix:**
```bash
flair start
```

If it fails to start:
```bash
# Check for port conflict
lsof -i :19926

# Check logs (macOS)
cat ~/.flair/data/log/hdb.log | tail -50

# Check logs (Linux)
journalctl --user -u flair --since "10 minutes ago"
```

### "Semantic search DEGRADED — embeddings not loaded"

**Symptoms:** `flair doctor` or `flair init` reports `Semantic search DEGRADED — embeddings not loaded; recall-by-meaning will NOT work.` A paraphrase search doesn't recall a memory it should match by meaning; search only finds exact keyword overlaps.

**Cause:** The in-process embeddings component (`harper-fabric-embeddings` / the nomic model) failed to initialize, so `SemanticSearch` fell back to a keyword-only scan. The most common cause on a fresh box is a **root-owned global install**: `sudo npm install -g @tpsdev-ai/flair` makes the package directory owned by root, but Harper runs as your user and gets `EACCES` when the embeddings component tries to download/symlink the model file under that package.

**Fix — reinstall without sudo (recommended):**
```bash
# Use a user-writable npm prefix so the package dir is yours (see README Quick Start)
mkdir -p ~/.npm-global && npm config set prefix ~/.npm-global
export PATH="$HOME/.npm-global/bin:$PATH"     # add to your shell rc to persist

npm uninstall -g @tpsdev-ai/flair             # remove the root-owned copy (may need sudo to remove it)
npm install -g @tpsdev-ai/flair               # reinstall, no sudo
flair restart
flair doctor                                  # should now report semantic search operational
```

**Other causes:** a missing native llama.cpp addon for your platform, or a corrupted/partial model download. `flair doctor` prints the underlying init error; `flair reembed` re-downloads the model and regenerates embeddings once the component loads.

**HuggingFace outage:** the model normally resolves from HuggingFace (`nomic-ai/nomic-embed-text-v1.5-GGUF`). If HF is down or 403/429-ing, point `FLAIR_MODELS_DIR` at a directory containing your own copy of `nomic-embed-text-v1.5.Q4_K_M.gguf` instead of waiting it out:
```bash
mkdir -p ~/models
curl -fSL -o ~/models/nomic-embed-text-v1.5.Q4_K_M.gguf \
  https://github.com/tpsdev-ai/flair/releases/download/ci-models/nomic-embed-text-v1.5.Q4_K_M.gguf
sha256sum ~/models/nomic-embed-text-v1.5.Q4_K_M.gguf
# expect: d4e388894e09cf3816e8b0896d81d265b55e7a9fff9ab03fe8bf4ef5e11295ac

export FLAIR_MODELS_DIR=~/models   # add to your shell rc to persist
flair restart
```
The `ci-models` release above is a first-party mirror of the same file (public, no auth required) that flair's own CI falls back to for the same reason — same-origin with GitHub, no dependency on HF's availability. Always verify the sha256 against the value printed here (or in `scripts/ci/model-checksums.txt` in the repo) before pointing Harper at a manually-downloaded file.

### "Embeddings: hash-fallback (512-dim)"

**Symptoms:** `flair status` shows hash-fallback instead of nomic. Search returns poor results.

**Cause:** The nomic-embed-text model failed to load. Usually a missing native binary or corrupted model file.

**Fix:**
```bash
flair doctor    # shows the specific error
flair reembed   # re-downloads model and regenerates embeddings
```

If `flair doctor` shows a native addon error:
```bash
# Reinstall with native dependencies
npm install -g @tpsdev-ai/flair --force
flair restart
```

### "invalid_signature" errors

**Symptoms:** API calls return `{"error": "invalid_signature"}`.

**Causes:**
1. Agent key doesn't match what's registered in Flair
2. Clock skew (signature includes timestamp)
3. Wrong agent ID

**Fix:**
```bash
# Verify the agent exists
flair agent list

# Re-register the agent's public key
flair agent rotate-key <agent-id>

# Check system clock
date
```

If using the MCP server, restart Claude Code after rotating keys.

### Port conflict

**Symptoms:** `flair start` fails, "address already in use".

**Fix:**
```bash
# Find what's using the port
lsof -i :19926

# If it's a stale Flair process
flair stop
flair start

# If it's another application, use a different port
flair init --port 29926
# Or edit ~/.flair/config.yaml and restart
```

### MCP server can't connect

**Symptoms:** Claude Code shows "Flair tools unavailable" or bootstrap returns nothing.

**Check:**
```bash
# Is Flair running?
flair status

# Can you reach it?
curl http://localhost:19926/Health

# Is the agent registered?
flair agent list
```

**Common fixes:**
- Set `FLAIR_URL` in your MCP config if using a non-default port
- Ensure `FLAIR_AGENT_ID` matches a registered agent
- Restart Claude Code after config changes

### Memories not showing up in search

**Symptoms:** You wrote a memory but search doesn't find it.

**Possible causes:**
1. **Hash-fallback embeddings:** Check `flair status` — if embeddings are in hash mode, semantic search won't work properly. Fix with `flair reembed`.
2. **Content safety flags:** The memory might have been flagged. Search for it directly: `flair memory list --agent <id>`.
3. **`visibility: private`:** Reads are open within the org by default — any agent can find any other agent's non-private memories. If the memory was written with `visibility: private`, only its author can find it; search as that agent instead.
4. **Dedup threshold:** If the content is very similar to an existing memory, it may have been deduplicated. Check with `flair memory list`.

### High memory usage

**Symptoms:** Harper process using excessive RAM.

**Context:** Harper with nomic-embed-text loads a ~270MB model into memory. This is normal. Total memory usage should stabilize around 400-600MB.

If memory keeps growing:
```bash
flair restart   # clean restart
flair doctor    # check for issues
```

### "content_safety_violation" on write

**Symptoms:** Memory write rejected with safety error.

**Cause:** Content matched a prompt injection pattern and strict mode is enabled (`FLAIR_CONTENT_SAFETY=strict`).

**Fix:** Either rephrase the content to avoid injection patterns, or switch to default mode (remove `FLAIR_CONTENT_SAFETY=strict` from environment). In default mode, flagged content is stored but tagged — not rejected.

## Getting Help

```bash
flair doctor          # automated diagnosis
flair status          # server state
flair --help          # all commands
flair <command> -h    # command-specific help
```

Logs: `~/.flair/data/log/hdb.log`

File issues: [github.com/tpsdev-ai/flair/issues](https://github.com/tpsdev-ai/flair/issues)
