# Deployment Guide

Run Flair on macOS, Linux, or Docker.

## macOS (Apple Silicon)

### Install

```bash
npm install -g @tpsdev-ai/flair
flair init
```

`flair init` will:
- Download Harper and the nomic-embed-text embedding model
- Create `~/.flair/` (config, data, keys)
- Generate admin credentials
- Install a launchd plist for auto-start on boot
- Start the server

### Verify

```bash
flair status
flair doctor
```

### Auto-start

`flair init` installs a launchd plist at `~/Library/LaunchAgents/ai.tpsdev.flair.plist`. Flair starts automatically on login and restarts if it crashes.

```bash
# Manual control
flair stop
flair start
flair restart
```

### Port

Default port is `19926`. Override during init:

```bash
flair init --port 9926
```

Or edit `~/.flair/config.yaml` and restart.

---

## Linux

### Prerequisites

- Node.js >= 22
- systemd (for auto-start)

### Install

```bash
npm install -g @tpsdev-ai/flair
flair init
```

Same as macOS — detects the platform and generates a systemd unit file instead of a launchd plist.

### Verify

```bash
flair status
flair doctor
```

### Auto-start

The systemd unit file is installed at `~/.config/systemd/user/flair.service`.

```bash
# Manual control
systemctl --user start flair
systemctl --user stop flair
systemctl --user restart flair

# View logs
journalctl --user -u flair -f
```

---

## Docker

### Quick test (from-scratch validation)

```bash
cd docker/
./test-from-scratch.sh
```

This runs a clean install in a container — useful for verifying the install path works on a fresh machine.

### Production Docker

```dockerfile
FROM node:22-slim
RUN npm install -g @tpsdev-ai/flair
RUN flair init --skip-soul
EXPOSE 19926
CMD ["flair", "start", "--foreground"]
```

Note: embeddings run on CPU in Docker (no Metal acceleration). Performance is acceptable for small-to-medium memory stores (< 10K memories).

---

## Remote Access

### SSH tunnel (simplest)

```bash
ssh -f -N -L 19926:localhost:19926 your-server
```

Then set `FLAIR_URL=http://localhost:19926` on the client.

### Direct network access

Edit `~/.flair/config.yaml`:

```yaml
http:
  port: 19926
  host: 0.0.0.0  # listen on all interfaces
```

**Security:** Flair uses Ed25519 authentication. Agents must present a valid signature to read or write. However, the `/Health` endpoint is unauthenticated. For internet-facing deployments, put Flair behind a reverse proxy with TLS.

---

## Configuration

All configuration lives in `~/.flair/`:

```
~/.flair/
├── config.yaml          # port, host, embedding model
├── data/                # Harper database
├── keys/                # Ed25519 keypairs per agent
└── backups/             # flair backup output
```

### Key config options (`~/.flair/config.yaml`)

```yaml
http:
  port: 19926            # API port (ops port = this - 1)
  host: 127.0.0.1        # bind address

clustering:
  nodeName: flair

logging:
  level: warn
  stdStreams: true
```

---

## Backup & Restore

```bash
# Backup all data (agents, memories, souls)
flair backup > ~/flair-backup-$(date +%Y%m%d).json

# Restore to a fresh instance
flair restore < ~/flair-backup-20260405.json
```

Always backup before upgrades.

---

## Uninstall

```bash
flair uninstall   # stops server, removes ~/.flair/, removes launchd/systemd service
npm uninstall -g @tpsdev-ai/flair
```
