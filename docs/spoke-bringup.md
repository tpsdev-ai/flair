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

Default is **19926** for REST / **19925** for ops. If you need to override (port conflict, multiple instances):

```bash
flair init --agent-id <id> --port 8000
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

### 5a. Generate a pairing token

The command prints one JSON object. Tokens expire after **60 minutes** by default. Use `--ttl <minutes>` to extend.

```json
{
  "token": "<one-time-pairing-token>",
  "user": "pair-bootstrap-xxxxxxxx",
  "password": "<bootstrap-password>",
  "expiresAt": "<ISO-8601>"
}
```

#### Hub you can shell into

On the **hub host**, an admin runs:

```bash
(umask 077; set -C; FLAIR_ADMIN_PASS="$(cat ~/.flair/admin-pass)" flair federation token > pair-triple.json)
```

`umask 077` sets the mode of a file the redirect CREATES; an existing file keeps its mode, so `set -C` (noclobber) makes the redirect refuse to overwrite it. Remove an old `pair-triple.json` first (`rm pair-triple.json`).

#### Harper Fabric hub (no shell)

A Fabric-deployed hub is a Harper component on a managed cluster. There is no host to shell into. Mint the triple from any machine that can reach the hub — for a personal spoke, that machine is the spoke — and name both the data URL and the ops URL:

```bash
(umask 077; set -C; FLAIR_ADMIN_PASS="$(cat /path/to/hub-admin-pass)" flair federation token \
  --target https://<hub>.<org>.harperfabric.com \
  --ttl 60 \
  --ops-target https://<hub>.<org>.harperfabric.com:9925 > pair-triple.json)  # docs-freshness-allow: Fabric ops API port, not legacy data port
```

`/path/to/hub-admin-pass` is a 0600 file holding the **HUB** admin password on the minting machine, not the spoke's `~/.flair/admin-pass`, which authenticates only the spoke. A literal on the command line would land in shell history, so read it from the file (or a secret manager). `--ops-target` is the Harper operations API on the same hostname at port 9925. <!-- docs-freshness-allow: Fabric ops API port, not legacy data port --> A portless `https://` `--target` derives that same port. Pass `--ops-target` so the URL is the one you chose. An explicit port other than 443 still derives as REST port minus one, which is not this ops port. `federation token` reads the admin password from `FLAIR_ADMIN_PASS` (or from `--admin-pass`). `--admin-pass` is also accepted but puts the password in shell history and process listings; prefer the file form above (or a secret manager).

### 5b. Transfer the triple to the spoke

When the triple was minted **on the hub host**, copy it to the spoke:

```bash
scp hub-host:/path/to/pair-triple.json ./pair-triple.json
```

When it was minted with `--target` against a Fabric hub, the file is already on the machine that ran the command. If that machine is the spoke, this step is done. The file holds a one-time credential — delete it after pairing.

### 5c. Pair from the spoke

```bash
FLAIR_ADMIN_PASS="$(cat ~/.flair/admin-pass)" flair federation pair https://<hub-url> \
  --token-from ./pair-triple.json
```

The spoke admin credential (`FLAIR_ADMIN_PASS` as above, or `--admin-pass`) is required so the CLI can write the hub as a local `Peer` record. Without it, pairing succeeds on the hub side but the spoke never records its peer, and `flair federation sync` reports "No hub peer configured."

### 5d. What pairing does

1. The spoke POSTs a signed pairing request to the hub's `/FederationPair` endpoint.
2. The bootstrap user authenticates at the Harper platform layer (works on standalone and Fabric deployments alike).
3. The hub validates the one-time token, verifies the Ed25519 signature, and creates a `Peer` record. The response includes the hub's `instance {id, publicKey}` when the hub has a FederationInstance row.
4. The spoke writes a `Peer` record pointing to the hub so sync knows where to push. A missing hub `publicKey` is an error, never an empty string. That does not create the hub's Instance row.

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

Then verify the pairing. `federation verify` pushes the canary itself — you
do not need the systemd timer from §7 first:

```bash
flair federation verify --admin-pass "$FLAIR_ADMIN_PASS"
flair federation reachability
```

`verify` writes a tagged memory, syncs it, and checks each peer. HTTP 401/403,
an unreachable peer, or a revoked leftover row is UNVERIFIABLE (a warning),
not FAIL. A reachable peer that is missing the canary still fails.
`reachability` should report `OK` for local and the hub.

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

### 🔸 Legacy hub on the old default (9926) vs a fresh spoke (19926)

Flair's default REST port changed from 9926 to 19926 (ops: 9925 → 19925) to avoid Harper port collisions (see CHANGELOG.md). `flair init` today always resolves and persists the CLI's real `DEFAULT_PORT` — **19926** — to `~/.flair/config.yaml`, and that's what a fresh spoke gets. But a hub that was provisioned before that bump may still be running on the old 9926/9925 pair — nothing auto-migrates an existing instance's config. Don't assume the hub is on the current default; confirm its actual port with the hub admin, or check `~/.flair/config.yaml` on the hub host.

**Fix:** Pass the hub's actual URL (with its real port) to `flair federation pair` — never assume 19926. On the spoke side, confirm your own config matches what `flair init` actually wrote:

```bash
# Verify the spoke's own config:
grep port ~/.flair/config.yaml
# → port: 19926   (fresh install, or whatever you passed via --port)

# Or set explicitly if pairing to a hub still on the legacy default:
export FLAIR_URL=http://127.0.0.1:9926
```

### 🔸 Harper Fabric hub vs a self-hosted explicit port

A managed Harper Fabric hub (`https://<hub>.<org>.harperfabric.com`, HTTPS on 443) serves the operations API on port 9925 of the same hostname. <!-- docs-freshness-allow: Fabric ops API port, not legacy data port --> Mint the pairing token with `--target` and `--ops-target` as in [§5a](#harper-fabric-hub-no-shell). Pairing from the spoke still uses the public hub URL:

```bash
FLAIR_ADMIN_PASS="$(cat ~/.flair/admin-pass)" flair federation pair https://<hub>.<org>.harperfabric.com \
  --token-from ./pair-triple.json
```

A self-hosted instance that publishes an explicit REST port still uses ops = REST − 1 (a fresh local install is 19926 → 19925). Pass that ops URL with `--ops-target` when you are not on the box:

```bash
FLAIR_ADMIN_PASS="$(cat ~/.flair/admin-pass)" flair federation pair https://fabric-node.example.com:19926/<instance> \
  --token-from triple.json \
  --ops-target https://fabric-node.example.com:19925
```

---

## 9. Quick Reference

| Step | Command |
|------|---------|
| Install | `npm install -g @tpsdev-ai/flair` |
| Init spoke | `flair init --agent-id <id> --data-dir /data/flair --skip-soul` |
| Check status | `flair status` / `flair federation status` |
| Hub: mint token | On the hub host: `(umask 077; set -C; FLAIR_ADMIN_PASS="$(cat ~/.flair/admin-pass)" flair federation token > triple.json)`. Harper Fabric hub (no shell): §5a `--target` + `--ops-target` |
| Spoke: pair | `FLAIR_ADMIN_PASS="$(cat ~/.flair/admin-pass)" flair federation pair <hub-url> --token-from ./triple.json` |
| Spoke: sync | `FLAIR_ADMIN_PASS="$(cat ~/.flair/admin-pass)" flair federation sync` |
| Spoke: verify | `FLAIR_ADMIN_PASS="$(cat ~/.flair/admin-pass)" flair federation verify` then `flair federation reachability` |
| Watch loop | `flair federation watch --interval 30` |

---

## See Also

- [federation.md](federation.md) — hub-and-spoke architecture, security model, CLI reference
- [deployment.md](deployment.md) — systemd/launchd setup, backup/restore
- [system-requirements.md](system-requirements.md) — RAM, disk, and scaling expectations
- [troubleshooting.md](troubleshooting.md) — common failure modes and fixes
