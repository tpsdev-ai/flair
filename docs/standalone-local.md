# Standalone Local Deployment

`flair init` installs and runs its own Harper process. This is the default path and what most operators use: a single process on a single machine, no Fabric, no external services.

If you're starting from zero, begin with the [quickstart](quickstart.md). This page covers the full lifecycle: install, configuration, authentication, verification, and upgrade.

---

## Install & deploy

**Prerequisites:** Node.js 22+ (LTS or current). No Docker, no database, no API keys.

### 1. Install the CLI

Use a **user-writable npm prefix** so the package directory is owned by you. A root-owned install (`sudo npm install -g`) breaks the embeddings component at runtime:

```bash
mkdir -p ~/.npm-global
npm config set prefix ~/.npm-global
export PATH="$HOME/.npm-global/bin:$PATH"  # add to your shell rc to persist

npm install -g @tpsdev-ai/flair
```

> ⚠️ **Never `sudo npm install -g @tpsdev-ai/flair`.** A root-owned install makes the package directory unwritable by the user Harper runs as. At runtime the embeddings component gets `EACCES` and semantic search silently degrades to keyword-only. `flair init` and `flair doctor` will warn you loudly.

### 2. Bootstrap the instance

```bash
flair init
```

`flair init` does everything in one step:

1. Installs the embedded Harper (memory store) into `~/.flair/data/`.
2. Downloads the local embedding model (~80 MB — first run only).
3. Starts Flair as a launchd / systemd service on port `19926`.
4. Creates a default agent identity (Ed25519 keypair, stored at `~/.flair/keys/<agent>.key`).
5. Runs a smoke test to confirm semantic search works.

Useful flags:

```bash
flair init --agent mybot           # name the agent (--agent-id also works)
flair init --client claude-code    # wire one specific MCP client
flair init --no-mcp                # instance + agent only, skip MCP wiring
flair init --skip-smoke            # skip the MCP smoke test
flair init --port 8000             # use a non-default port
```

> **Non-interactive shell:** bare `flair init` with no `--agent` bootstraps the instance only and skips agent registration, MCP client wiring, and the smoke test. Pass flags explicitly: `flair init --agent <id> --client all`.

### 3. Lifecycle management

```bash
flair status        # check everything is working
flair stop          # stop the service (keeps data)
flair restart       # restart the service
flair uninstall     # remove the service (keeps data + keys)
flair uninstall --purge   # remove everything including data and keys
```

On macOS the service is a launchd plist at `~/Library/LaunchAgents/ai.tpsdev.flair.plist`. On Linux it is a systemd unit at `~/.config/systemd/user/flair.service`. Both auto-start on login/boot and restart on crash.

### Docker

Flair does not have a foreground daemon mode today (`flair start` has no `--foreground` option and `flair init` always installs a service manager unit). There is no supported Docker recipe — run Flair directly on the host or use [Harper Fabric](https://www.harperdb.io/) for managed hosting.

Embeddings run on CPU in any containerized environment (no Metal acceleration). Performance is acceptable for small-to-medium memory stores (< 10K memories).

See also: [system-requirements.md](system-requirements.md) for measured resource usage.

---

## Configuration

All configuration lives in `~/.flair/`:

```
~/.flair/
├── config.yaml          # port, host, embedding model
├── data/                # Harper database (RocksDB)
├── keys/                # Ed25519 keypairs per agent (mode 0600)
└── backups/             # flair backup output
```

### Key config options (`~/.flair/config.yaml`)

```yaml
http:
  port: 19926            # API port (ops port = this - 1)
  host: 127.0.0.1        # bind address (0.0.0.0 for remote access)

clustering:
  nodeName: flair

logging:
  level: warn
  stdStreams: true
```

### Environment variables

| Variable | What it does | When to set it |
|----------|--------------|----------------|
| `FLAIR_PUBLIC_URL` | The URL operators reach this Flair on. Used by OAuth metadata and A2A discovery. | Set on VPS / internet-facing deployments. |
| `HDB_ADMIN_PASSWORD` | Bootstrap password for the embedded Harper. After first start, the persisted user record is the source of truth. | Set at install time. See [secrets-and-keys.md](secrets-and-keys.md) for rotation. |
| `FLAIR_KEY_PASSPHRASE` | Passphrase for AES-256-GCM encryption of federation private-key seeds. | Set explicitly for production federation deployments. |
| `FLAIR_URL` | Override the Flair base URL for CLI commands (points to a remote instance). | When connecting from a different machine. |

---

## Agent authentication

Agents authenticate with **Ed25519 per-agent keys**:

```bash
# Register an agent (generates Ed25519 keypair at ~/.flair/keys/myagent.key)
flair agent add myagent

# List registered agents
flair agent list
```

Every request to Flair is signed with the agent's private key. The signed payload is `agentId:timestamp:nonce:METHOD:/path` with a 30-second replay window and nonce deduplication. Unsigned requests are rejected.

This guarantees **write isolation** (no agent can write as another) and identity-verified reads. Reads are intentionally more open: any verified agent on the same instance can read any other agent's non-private memories. Only `visibility: private` memories are owner-only. See [SECURITY.md](../SECURITY.md) for the full model.

### The private key

- Lives at `~/.flair/keys/<agent>.key` (PKCS8 base64, mode `0600`).
- **Stays on the host that owns the agent.** Don't copy it to another machine — register a new agent identity there.
- **Don't check it into git.** Rotate first if compromised: `flair agent rotate-key <id>`.
- `flair backup` excludes private keys by default. Back them up separately if you want offsite recovery.

See [secrets-and-keys.md](secrets-and-keys.md) for the full threat model and key lifecycle.

---

## Verify it works

### Quick health check

```bash
flair status
```

The **🟢** icon means everything is healthy. A **🟡** means something worth looking at; **🔴 unreachable** means the server isn't running.

```bash
flair status --agent local     # full detail: memory counts, soul entries
flair doctor                   # automated diagnosis + fix suggestions
```

### End-to-end smoke test

```bash
# Write a memory
flair memory add --agent myagent "Harper v5 sandbox blocks node:module but process.dlopen works"

# Find it by meaning (not keywords)
flair memory search --agent myagent "native addon loading in sandboxed runtimes"
# → [0.67] Harper v5 sandbox blocks node:module but process.dlopen works
```

### Connectivity

```bash
curl http://localhost:19926/Health              # public, no auth needed
flair doctor                                    # checks embeddings, auth, connectivity
```

See [troubleshooting.md](troubleshooting.md) for common issues and fixes.

---

## Upgrade

`flair upgrade` is install → restart → verify → rollback-on-failure in one step:

```bash
# 1. Back up first, always
flair backup --output ~/flair-backup-$(date +%Y%m%d).json --admin-pass-file ~/.flair/admin-pass

# 2. Check what's outdated (doesn't install anything)
flair upgrade --check

# 3. Upgrade — installs, restarts, and verifies in one step
flair upgrade

# 4. Verify
flair status
flair doctor
```

Optional: `flair upgrade --snapshot` takes a byte-exact snapshot of `~/.flair/data` before upgrading, so you can restore the physical data directory if the new version writes data the old version can't read.

See [upgrade.md](upgrade.md) for the full walkthrough including re-embedding, rollback, and downgrade.

---

## Backup & restore

```bash
# Backup all data (agents, memories, souls)
flair backup --output ~/flair-backup-$(date +%Y%m%d).json

# Restore to a fresh instance
flair restore ~/flair-backup-20260405.json
```

Always backup before upgrades. `flair backup` excludes private keys.

---

## Federation

Available. Pair a local instance as a hub or spoke with another Flair instance:

```bash
# On the hub — generate a one-time pairing token triple
FLAIR_ADMIN_PASS=<hub-admin-password> flair federation token > triple.json

# On the spoke — pair to the hub
flair federation pair <hub-url> --token-from ./triple.json

# Sync (one-shot)
flair federation sync --admin-pass-file ~/.flair/admin-pass
```

Full walkthrough: [federation.md](federation.md).

---

## See also

- [deployment-shapes.md](deployment-shapes.md) — choose your shape
- [quickstart.md](quickstart.md) — zero to working in 5 minutes
- [upgrade.md](upgrade.md) — full upgrade mechanics (re-embedding, rollback, downgrade)
- [federation.md](federation.md) — hub-and-spoke sync between instances
- [troubleshooting.md](troubleshooting.md) — common issues and automated diagnosis
- [system-requirements.md](system-requirements.md) — measured resource usage
- [secrets-and-keys.md](secrets-and-keys.md) — agent keys, admin password, threat model
