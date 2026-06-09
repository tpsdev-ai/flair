# Spoke Bring-Up Recipe

Headless recipe to stand up a new Flair spoke that federates to the `flair.dtrt` hub. This is a **cut-and-paste operator guide** — every command is real and tested against the current CLI.

**Target:** fresh linux-x64 VM.
**Result:** a running spoke with an Ed25519-registered agent, paired to the hub, and pushing memories.

---

## 1. Prerequisites

- **Node.js ≥ 22** on a linux-x64 VM. Verify:

  ```bash
  node --version   # ≥ v22.x
  ```

- **Outbound HTTPS** to the hub. The spoke pushes to the hub on `flair federation sync`; the hub never dials back.

- **Admin access** to the hub — you'll need someone (or yourself, on the hub host) to run `flair federation token` and give you the resulting JSON triple.

---

## 2. Install Flair

```bash
npm install -g @tpsdev-ai/flair
```

Confirm the CLI is reachable:

```bash
flair --version
```

---

## 3. Bootstrap the Spoke (init + agent)

`flair init` handles Harper install, data-dir setup, admin-password generation, and agent registration in one shot.

### 3a. Default (auto-generated admin pass, default data dir)

```bash
flair init --agent-id <spoke-agent-id>
```

- Harper installs into `~/.flair/data/`.
- Admin password is auto-generated and written to `~/.flair/admin-pass` (mode 0600).
- An Ed25519 keypair is created at `~/.flair/keys/<agent-id>.key`.
- After boot, the interactive soul wizard runs — press `s` to skip in a headless pipe, or use `--skip-soul`.

### 3b. Explicit data dir + admin pass (headless)

```bash
export FLAIR_ADMIN_PASS="$(openssl rand -base64 24)"
mkdir -p /data/flair

flair init \
  --agent-id <spoke-agent-id> \
  --data-dir /data/flair \
  --admin-pass "$FLAIR_ADMIN_PASS" \
  --skip-soul
```

The admin password is passed via env (`FLAIR_ADMIN_PASS` / `HDB_ADMIN_PASSWORD`), which keeps it out of shell history. If you use `--admin-pass inline-value`, the CLI prints a warning.

### 3c. Custom port

Default is **9926** for REST / **9925** for ops. If you need to override (port conflict, multiple instances):

```bash
flair init --agent-id <id> --port 19926
```

Port is persisted to `~/.flair/config.yaml`. The ops port is always REST port − 1 (derived automatically).

---

## 4. Verify the Spoke Is Running

```bash
flair status
```

Expected output: green **🟢 running** with your agent listed. If you see **🔴 unreachable**, check [docs/troubleshooting.md](troubleshooting.md).

To check the instance's federation identity:

```bash
flair federation status
```

At this point you'll see your instance ID, public key, and role: `spoke`. The peer list will be empty — pairing comes next.

---

## 5. Pair with the Hub

### 5a. Generate a pairing token on the hub

On the **hub host**, an admin runs:

```bash
flair federation token --admin-pass <hub-admin-pass> > pair-triple.json
```

Output (a single JSON object):

```json
{
  "token": "<one-time-pairing-token>",
  "user": "pair-bootstrap-xxxxxxxx",
  "password": "<bootstrap-password>",
  "expiresAt": "<ISO-8601>"
}
```

Tokens expire after **60 minutes** by default. Use `--ttl <minutes>` to extend.

### 5b. Transfer the triple to the spoke

```bash
scp hub-host:/path/to/pair-triple.json ./pair-triple.json
```

### 5c. Pair from the spoke

```bash
flair federation pair https://<hub-url> \
  --token-from ./pair-triple.json \
  --admin-pass "$FLAIR_ADMIN_PASS"
```

The `--admin-pass` is required so the CLI can write the hub as a local `Peer` record. Without it, pairing succeeds on the hub side but the spoke never records its peer, and `flair federation sync` reports "No hub peer configured."

### 5d. What pairing does

1. The spoke POSTs a signed pairing request to the hub's `/FederationPair` endpoint.
2. The bootstrap user authenticates at the Harper platform layer (works on standalone and Fabric deployments alike).
3. The hub validates the one-time token, verifies the Ed25519 signature, and creates a `Peer` record.
4. The spoke writes a `Peer` record pointing to the hub so sync knows where to push.

---

## 6. Sync for the First Time

```bash
flair federation sync --admin-pass "$FLAIR_ADMIN_PASS"
```

Expected:

```
Syncing to hub: <hub-instance-id>...
✅ Synced 0 records (0 skipped) in 45ms
```

Then verify reachability across the federation:

```bash
flair federation reachability
```

Both local and hub peer should report `OK`.

---

## 7. Persist Sync (Production)

For the spoke to stay connected continuously, wrap `flair federation sync` in a loop.

### systemd timer (Linux)

Create `~/.config/systemd/user/flair-sync.service`:

```ini
[Unit]
Description=Flair federation sync (one-shot)
After=flair.service

[Service]
Type=oneshot
ExecStart=/usr/bin/env bash -c 'FLAIR_ADMIN_PASS="$(<~/.flair/admin-pass)" flair federation sync'
Environment=HOME=%h
```

and a timer at `~/.config/systemd/user/flair-sync.timer`:

```ini
[Unit]
Description=Flair federation sync timer

[Timer]
OnUnitActiveSec=30s
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now flair-sync.timer
```

### Built-in watch (foreground, for testing)

```bash
flair federation watch --interval 30
```

Press Ctrl-C to stop.

---

## 8. Known Gotchas

### 🔸 bun pins the wrong llama.cpp platform binary

Harper's NAPI modules (`llama.cpp`-backed embeddings) are built for **Node.js**, not bun. The test harness explicitly spawns Harper under `node` because bun 1.3.x doesn't support `uv_ip6_addr` — Harper crashes with a NAPI resolve panic.

**Fix:** Always run Flair under Node.js. Set `NODE_HOSTNAME=127.0.0.1` (IPv4 only) in the Harper environment to bypass the IPv6 path entirely. The `flair init` command does this automatically.

```bash
# In Harper env (done automatically by flair init):
NODE_HOSTNAME=127.0.0.1
```

### 🔸 Symlink not followed by Harper sandbox

The Harper v5 sandbox blocks `node:module` (used by `createRequire` for bridge resolution) but `process.dlopen` (native addon loading) works. Some bridge packages and the OpenClaw Flair plugin reference workspace files via symlinks — Harper's sandbox won't follow them, and the plugin explicitly skips symlink escapes with a warning.

**Fix:** Keep workspace files and Flair data on the same filesystem without symlinks crossing mount boundaries. If you see "skipping anchor symlink escape" warnings in the plugin logs, copy the file instead of symlinking.

### 🔸 Old data-dir `lockdown:freeze` jails

If Harper was previously installed with `lockdown:true` in `harper-config.yaml` or if the data dir contains a stale `hdb_boot_properties.file` from an unrelated Harper install, the install step crashes in Harper v5 beta.6+ (`checkForExistingInstall` queries the database before environment init).

**Fix:** Start with a clean data dir. If reusing an existing dir, ensure no `~/.harperdb/hdb_boot_properties.file` exists and that the data dir's `harper-config.yaml` doesn't set `lockdown: true`.

```bash
# Clean up old Harper state before init:
rm -f ~/.harperdb/hdb_boot_properties.file
# If the data dir has lock-related entries, nuke it and re-init:
rm -rf /data/flair
flair init --data-dir /data/flair --agent-id <id>
```

### 🔸 CLI config port 9926 vs 19926 drift

The CLI's `DEFAULT_PORT` constant is `19926`, but the real Harper instance listens on **9926** (with ops on **9925**). The port-resolution chain resolves this at runtime (`FLAIR_URL` env → `~/.flair/config.yaml` → default 9926), but if neither env nor config is set, the CLI falls through to `19926` and gets ECONNREFUSED.

**Fix:** Always set `FLAIR_URL` or write port to `~/.flair/config.yaml`. `flair init` writes `port: 9926` to config automatically. If you ran `flair init --port 19926`, the config gets 19926 and everything aligns — the mismatch only bites when init uses one port and subsequent commands expect the other without config.

```bash
# Verify config has the right port:
grep port ~/.flair/config.yaml
# → port: 9926

# Or set explicitly:
export FLAIR_URL=http://127.0.0.1:9926
```

### 🔸 rockit serves REST on 9926, ops on 9925

Fabric/rockit deployments split the REST API (port 9926) and the Harper operations API (port 9925). The derivation rule is **ops = REST − 1**. When pointing a CLI at a remote Fabric instance, pass `--target` for REST and the ops URL is derived automatically:

```bash
flair federation pair https://fabric-node.example.com:9926/<instance> --token-from triple.json
```

For explicit ops control:

```bash
flair federation pair https://fabric-node.example.com:9926/<instance> \
  --token-from triple.json \
  --ops-target https://fabric-node.example.com:9925
```

---

## 9. Quick Reference

| Step | Command |
|------|---------|
| Install | `npm install -g @tpsdev-ai/flair` |
| Init spoke | `flair init --agent-id <id> --data-dir /data/flair --skip-soul` |
| Check status | `flair status` / `flair federation status` |
| Hub: mint token | `flair federation token --admin-pass <pass> > triple.json` |
| Spoke: pair | `flair federation pair <hub-url> --token-from ./triple.json --admin-pass <pass>` |
| Spoke: sync | `flair federation sync --admin-pass <pass>` |
| Spoke: verify | `flair federation reachability` |
| Watch loop | `flair federation watch --interval 30` |

---

## See Also

- [federation.md](federation.md) — hub-and-spoke architecture, security model, CLI reference
- [deployment.md](deployment.md) — systemd/launchd setup, backup/restore
- [system-requirements.md](system-requirements.md) — RAM, disk, and scaling expectations
- [troubleshooting.md](troubleshooting.md) — common failure modes and fixes
