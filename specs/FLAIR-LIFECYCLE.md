# Flair Lifecycle Commands — Spec

**Issues:** #150 (lifecycle), #151 (conflict-free ports)  
**Priority:** P1  
**Author:** Flint  

## Problem

1. **No lifecycle management:** `flair init` starts Harper but there's no `flair stop`, `flair restart`, or `flair uninstall`. Operators must manually find PIDs or manipulate launchd.

2. **Port conflicts:** Flair defaults to 9926/9925 which collide with standalone Harper installations. Users running both get silent failures.

## Solution

### 1. Lifecycle Commands

Add three new top-level commands to `src/cli.ts`:

#### `flair stop`
- Check for running Flair process (launchd on macOS, PID file on Linux)
- On macOS: `launchctl unload` the plist
- On Linux: read PID from `~/.flair/data/flair.pid`, send SIGTERM, wait up to 10s, SIGKILL if needed
- Print confirmation or "not running" message

#### `flair restart`  
- `stop` + `init` with same config
- Preserve existing config from `~/.flair/config.json` (written by `init`)
- If not initialized, error with "run flair init first"

#### `flair uninstall`
- `stop` first
- Remove launchd plist (macOS) or systemd unit (Linux)
- Ask interactively whether to remove data (`~/.flair/data`) and keys (`~/.flair/keys`)
- Default: keep data and keys (safe)
- `--purge` flag to remove everything without prompting

### 2. Conflict-Free Ports

Change defaults in `src/cli.ts`:
```typescript
const DEFAULT_PORT = 19926;      // was 9926
const DEFAULT_OPS_PORT = 19925;  // was 9925
```

Update `config.yaml` accordingly. The `init` command already accepts `--port` for custom overrides.

**Migration:** Existing installations with explicit port config in `~/.flair/config.json` are unaffected (the stored config takes precedence). Only new `flair init` runs get the new defaults.

### 3. Config Persistence

`flair init` already writes config. Ensure it stores:
```json
{
  "port": 19926,
  "opsPort": 19925,
  "dataDir": "~/.flair/data",
  "keysDir": "~/.flair/keys",
  "adminUser": "admin"
}
```

`flair restart` reads this config to reinitialize correctly.

## Files Changed

- `src/cli.ts` — new commands + default port change
- `config.yaml` — default port update
- `README.md` — update port references

## Testing

- `flair init` → starts on 19926
- `flair status` → shows running, correct port
- `flair stop` → stops cleanly
- `flair restart` → restarts with same config
- `flair uninstall` → removes service, data intact
- `flair uninstall --purge` → removes everything
- Existing users with port 9926 in config → still works (no breakage)

## Risk

Low-medium. Port change affects new installations only. Lifecycle commands are additive. The `uninstall --purge` path needs careful testing since it's destructive.
