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
flair init --port 8000
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

Note: embeddings run on CPU in Docker (no Metal acceleration). Performance is acceptable for small-to-medium memory stores (< 10K memories). Thread count follows `FLAIR_EMBED_THREADS` (default `max(1, availableParallelism() − 1)`); pin it if the container CPU quota and the host you want to use disagree.

---

## Harper Fabric

Deploying to a Harper Fabric cluster is a different mechanism from the installs above — `flair deploy` pushes Flair as a cluster component instead of `npm install -g`. To upgrade an already-deployed Fabric instance in place, use `FABRIC_USER=<admin> FABRIC_PASSWORD=<pass> flair upgrade --target <fabric-url>` (or `--fabric-password-file <path>` in place of the env var), not the local upgrade path. Inline `--fabric-user`/`--fabric-password` flags also work but are discouraged — both leak to shell history and `ps`. See [`docs/upgrade.md` — Upgrading a Fabric-deployed instance](upgrade.md#upgrading-a-fabric-deployed-instance) for the full walkthrough, including the automatic post-deploy fleet-convergence sweep.

New user who needs a reachable `FLAIR_URL` for Cursor / Grok Bot? Start at
[`docs/quickstart-fabric.md`](quickstart-fabric.md). For the hosted shape end to
end — when to choose it, ports and auth against a managed Fabric endpoint, pairing
local spokes to a hosted hub, and what you can and cannot observe without a shell
on the node — see [`docs/deploying-on-fabric.md`](deploying-on-fabric.md).

---

## Remote Access

### SSH tunnel (simplest)

```bash
ssh -f -N -L 19926:localhost:19926 your-server
```

Then set `FLAIR_URL=http://localhost:19926` on the client.

### Direct network access

On `flair start`, `flair restart`, and `flair upgrade` the HTTP bind host is resolved in this order. The first one set wins. None of those commands take an `--http-bind` flag:

1. `FLAIR_HTTP_BIND` in the Flair process environment
2. a **top-level** `httpBind:` key in `~/.flair/config.yaml`
3. `127.0.0.1`

`flair init --http-bind <host>` is how that `httpBind` key gets written. During `init` the flag wins over `FLAIR_HTTP_BIND`, and the host that won is persisted. On Linux the CLI starts Harper directly and resolves the bind on every start, so a later start follows the list above and an env var in the service's environment overrides the file. On macOS the resolved bind is stored in the launchd job instead of being re-read at each start: a restart started by launchd itself — a reboot, a crash, KeepAlive — reuses that stored value and does not re-read `FLAIR_HTTP_BIND` or `config.yaml`, so changing either has no effect on such a restart — the stored job has to be rewritten.

**Only hosts that include IPv4 loopback are accepted** — `127.0.0.1` itself, or a wildcard (`0.0.0.0` / `::`). Every credentialed self-call Flair makes hardcodes `127.0.0.1`. A bind that excludes that address is refused: those calls would point at a dead port while every bind check still passed. A specific LAN address is not accepted. Loopback is the default so a single-host install does not expose the HTTP surface, including unauthenticated `/Health`, on every interface.

To widen deliberately, record a wildcard so the choice survives restart and upgrade:

```bash
flair init --http-bind 0.0.0.0
```

```yaml
# ~/.flair/config.yaml — top-level key. There is no nested `http:` block.
httpBind: 0.0.0.0
```

A nested `http.host` (or `http.port`) is not read. An install that was only wide because an older default bound every interface narrows to `127.0.0.1` on the next `flair restart` or `flair upgrade` unless `FLAIR_HTTP_BIND` or `httpBind` names a wildcard.

**Confirm the bind.** `flair status` prints the URL the CLI dials. That URL stays on loopback even when the listener is widened, so it is not the bind. After a Flair-managed start, Harper records the listener it was given as `http.port` in the instance data directory (default `~/.flair/data/harper-config.yaml`, legacy name `harperdb-config.yaml`). The value is host-qualified, for example `127.0.0.1:19926`, `0.0.0.0:19926`, or `[::]:19926`. The live socket shows the same address:

```bash
lsof -nP -iTCP:19926 -sTCP:LISTEN
```

**Security:** Flair uses Ed25519 authentication. Agents must present a valid signature to read or write. However, the `/Health` endpoint is unauthenticated. For internet-facing deployments, put Flair behind a reverse proxy with TLS.

---

## Configuration

All configuration lives in `~/.flair/`:

```
~/.flair/
├── config.yaml          # port, opsPort, opsBind, httpBind
├── data/                # Harper database (harper-config.yaml lives here)
├── keys/                # Ed25519 keypairs per agent
└── backups/             # flair backup output
```

### Key config options (`~/.flair/config.yaml`)

Flair reads four top-level keys from this file: `port`, `opsPort`, `opsBind`, and `httpBind`. `flair init` rewrites the file with those keys and drops anything else, including a `clustering:` or `logging:` block and any embedding-model key. Embedding threads, GPU layers, and the model directory are environment variables in the table below, not keys in this file.

`clustering` and `logging` are not read from `~/.flair/config.yaml` or from `<dataDir>/harper-config.yaml` by anything in this repository, so they are not given a home here. Harper's generative `models:` block, when REM needs one, does belong in `<dataDir>/harper-config.yaml`. See [rem.md](rem.md).

```yaml
# ~/.flair/config.yaml — only these keys are read. A later `flair init`
# rewrites the file and drops every other key.
port: 19926
opsPort: 19925         # Harper operations API port
opsBind: 127.0.0.1     # operations API bind host
httpBind: 127.0.0.1    # HTTP bind host (see "Direct network access" above)
```

### Environment variables

Set these in the Flair process environment (`~/Library/LaunchAgents/ai.tpsdev.flair.plist` on macOS, the systemd unit on Linux, the component env on Fabric).

| Variable | What it does | When to set it |
|----------|--------------|----------------|
| `FLAIR_PUBLIC_URL` | The URL operators reach this Flair on (e.g. `https://flair.example.com`). Surfaced in the AdminInstance pane's Endpoints table and used by OAuth metadata + A2A discovery so external clients see a reachable URL. | **Always set on remote / VPS deployments** — unset means every URL a client is handed points at loopback. On Fabric, `flair deploy` sets it from the deploy target and verifies the result; see [deploying-on-fabric.md](deploying-on-fabric.md). Local-only installs can leave it unset. |
| `HDB_ADMIN_PASSWORD` | Bootstrap password for the embedded Harper. After first start, the persisted user record is the source of truth; rotate via the Harper ops API, not by changing this env var. | Set at install time. See [secrets-and-keys.md](secrets-and-keys.md) for rotation. |
| `FLAIR_KEY_PASSPHRASE` | Passphrase used to derive the AES-256-GCM key that wraps federation private-key seeds at rest. Auto-generated to `~/.flair/keys/.passphrase` if unset. | Set explicitly for production federation deployments so the passphrase isn't auto-generated and lost on disk wipe. |
| `HTTP_PORT` | Override the Harper HTTP port. Useful for sandboxes; production deployments should configure the port in `config.yaml` instead. | Rare. |
| `FLAIR_HTTP_BIND` | Bind address for the Harper **HTTP API**. On start, restart, and upgrade the order is this variable, then the top-level `httpBind` key in `~/.flair/config.yaml`, then `127.0.0.1`. `flair init --http-bind` writes that key (the flag wins over this variable during init). Only `127.0.0.1` or a wildcard (`0.0.0.0` / `::`) is accepted — the listener must include IPv4 loopback for Flair's own `127.0.0.1` self-calls. See [Direct network access](#direct-network-access). | Only for deployments that need the HTTP API reachable off-host — set it to `0.0.0.0`, or record it once with `flair init --http-bind 0.0.0.0`. Single-host installs want the loopback default. |
| `FLAIR_OPS_BIND` | Bind address for the Harper **ops API**. Resolution order: `flair init --ops-bind` > this variable > the `opsBind` key `flair init` persists in `~/.flair/config.yaml` > `127.0.0.1`. Every Flair-managed Harper start re-asserts the resolved value, so the persisted key is what makes a choice survive `flair restart` / `flair upgrade`. | Only for deployments that genuinely need remote ops admin (multi-host / Fabric) — set it to `0.0.0.0`, or record it once with `flair init --ops-bind 0.0.0.0`. Single-host installs want the loopback default. |

### Performance-related environment variables

These are read by the Harper process at boot (same places as the table above: launchd plist, systemd unit, component `.env` / Fabric env). They are **not** `config.yaml` keys — embedding registration is in-process and must not persist into Harper's config file.

| Variable | Default | What it does |
|----------|---------|--------------|
| `FLAIR_EMBED_THREADS` | `max(1, availableParallelism() − 1)` | CPU threads for in-process embedding (harper-fabric-embeddings / llama.cpp). Host-aware so a 4-core box does not inherit HFE's fixed 6, and an 8-vCPU ingest host is not stuck at 6 idle cores. One core is left for Harper's event loop and the OS. `availableParallelism()` respects a container CPU quota. Set a positive integer to pin. Invalid values fall back to the default. |
| `FLAIR_EMBED_GPU_LAYERS` | derived: `99` when a usable Metal backend is present (darwin-arm64 + resolvable `@node-llama-cpp/mac-arm64-metal`), else `0` | Layers to offload to the GPU. Unset **derives** the default and states it on the boot log and `/Health` (`embedding.backend` / `gpuLayers` / `source`). `0` = pin CPU; `99` = full offload. Invalid values fall through to the derived default. If offload is requested and Metal does not engage, Health and the log state the CPU fallback — they never claim GPU for a CPU run. |
| `FLAIR_HYBRID_RETRIEVAL` | `true` | Hybrid BM25 + vector retrieval. Set `false` / `0` / `off` to revert to the legacy HNSW + keyword-bump path. |
| `FLAIR_MODELS_DIR` | `<data-dir>/models` | Directory the embedding GGUF is loaded from (and downloaded into on first boot). Point this at a pre-seeded directory to skip the HuggingFace download; see [troubleshooting.md](troubleshooting.md). |

---

## Backup & Restore

```bash
# Backup all data (agents, memories, souls)
flair backup --output ~/flair-backup-$(date +%Y%m%d).json --admin-pass-file ~/.flair/admin-pass

# Restore to a fresh instance
flair restore ~/flair-backup-20260405.json
```

Always backup before upgrades.

---

## Uninstall

```bash
flair uninstall           # stop the server and remove the launchd/systemd service; keep data and keys
flair uninstall --purge   # also remove ~/.flair (data, keys, secrets), schedulers, and client wiring
npm uninstall -g @tpsdev-ai/flair
```
