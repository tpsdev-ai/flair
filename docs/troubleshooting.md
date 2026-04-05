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
3. **Agent isolation:** Memories are scoped to the agent that wrote them. Ensure you're searching with the correct agent ID.
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
