# Federation

Hub-and-spoke sync between Flair instances. A hub instance coordinates sync for one or more spoke instances.

## Overview

Federation lets multiple Flair instances share memories, relationships, and agent records. Each instance maintains its own Ed25519 identity. Sync requests are signed and verified against pinned peer public keys.

```
Spoke A ──[signed sync]──▶ Hub ◀──[signed sync]── Spoke B
```

- **Hub:** accepts sync pushes from paired spokes, can relay records between peers
- **Spoke:** pushes local changes to the hub, receives changes from other spokes via the hub

## Pairing a New Spoke (Bootstrap-User Flow)

Pairing connects a spoke to a hub with mutual key pinning and an auth-aware handshake that works across all Harper topologies, including Harper Fabric.

### Step-by-step

**1. Hub admin generates a pairing token triple**

On the hub machine, the admin runs `flair federation token`. The command emits a JSON triple containing a one-time bootstrap credential:

```bash
flair federation token --admin-pass <hub-admin-password>
```

Output (a single JSON object):

```json
{"token":"<one-time-pairing-token>","user":"<bootstrap-username>","password":"<bootstrap-password>","expiresAt":"<ISO-8601-timestamp>"}
```

Tokens expire after 60 minutes by default. Use `--ttl <minutes>` to adjust.

**2. Hub admin shares the triple with the spoke admin**

The JSON triple is shared out-of-band (secure file transfer, password manager, or similar). It must be stored as a plain JSON file on the spoke side or piped via stdin.

**3. Spoke admin runs the pair command**

On the spoke machine:

```bash
# From a file
flair federation pair <hub-url> --token-from /path/to/triple.json

# From stdin
cat triple.json | flair federation pair <hub-url> --token-from -
```

**4. Behind the scenes**

- The bootstrap user authenticates at the platform layer (works on standalone deployments and Harper Fabric alike).
- The resource handler validates the pairing token, the signed request body, and the binding between the bootstrap user and the token.
- On success the hub creates a `Peer` record for the spoke and removes the temporary bootstrap user. The spoke records the hub as its peer.

After pairing, both instances pin each other's Ed25519 public keys and are ready to sync.

## Why the Bootstrap-User Flow?

Earlier designs relied on `allowCreate=true` combined with body-only authentication. That approach works on single-component deployments but breaks on Harper Fabric, where the platform authentication gate fires before the resource handler sees the request. The bootstrap-user flow (Option B) makes the pair handshake auth-aware so it operates correctly on all Harper topologies: standalone, Fabric single-node, and Fabric multi-node.

## Fabric Pairing Example

When the hub runs on Harper Fabric, adapt the hub URL to the Fabric pattern:

```bash
# 1. Hub admin generates the triple (on the Fabric host)
ssh hub-host
flair federation token --admin-pass <hub-admin-password> > /tmp/pair-triple.json

# 2. Transfer the triple to the spoke admin (out-of-band)
scp hub-host:/tmp/pair-triple.json ./pair-triple.json

# 3. Spoke admin pairs using the Fabric URL
flair federation pair https://<fabric-node>:19926/<instance-name> --token-from ./pair-triple.json
```

Replace `<fabric-node>`, `<instance-name>`, and `<hub-admin-password>` with your actual values.

Running the hub on Fabric has its own considerations — port derivation against a managed
`443` endpoint, why the sync driver can only be installed on a machine you control, and
the observability limits of a node you have no shell on. See
[`docs/deploying-on-fabric.md`](deploying-on-fabric.md).

## Sync

Push local changes to the hub, once:

```bash
flair federation sync --admin-pass <password>
# Output: ✅ Synced 12 records (0 skipped) in 145ms
```

### Keeping it synced

`flair federation sync` is one-shot and `flair federation watch` only runs
while its terminal is open. Neither survives a logout, so a spoke that is only
ever synced by hand looks paired but stops replicating — enable the scheduled
driver instead:

```bash
flair federation sync enable                  # every 300s by default
flair federation sync enable --interval 900   # or pick your own cadence
flair federation sync status                  # is anything actually driving sync?
flair federation sync disable
```

This installs a **periodic one-shot**: a launchd job (`StartInterval`) on
macOS, a systemd user timer (`OnUnitActiveSec`) on Linux, each invoking
`flair federation sync` on the interval. It is deliberately not a supervised
long-lived watcher — the sync holds no state between runs, so a resident
process would buy nothing, and a supervisor cannot restart a process that
hangs rather than exits. The trade-off is latency, and `--interval` is the
knob. The first sync runs immediately on enable.

`flair federation watch` is unchanged and still the right tool for an
interactive "watch it sync while I debug" session.

**Credentials.** The scheduler never writes a password into a unit file. It
stores the *path* given to `--admin-pass-file` (defaulting to
`~/.flair/admin-pass` when that exists) and the CLI reads the file at run time,
refusing it unless it is owner-only (`chmod 600`). Pass `--no-credentials` to
wire none at all.

### Is anything driving sync?

`flair federation status` reports the driver alongside the peer table, because
"no peer has merged in 24h" has two completely different causes:

| What you see | What it means | What to do |
|---|---|---|
| `Sync driver: active` | A managed driver is loaded and syncs are landing | Nothing |
| `Sync driver: active … but no peer contact in <window>` | Sync **is** running; the runs are not reaching the peer | `flair federation reachability`, then the driver log |
| `Sync driver: NONE` | Nothing has run sync since you paired | `flair federation sync enable` |
| `Sync driver: INSTALLED BUT NOT LOADED` | Unit files exist, the service manager never loaded them | `flair federation sync enable` |
| `Sync driver: none managed by Flair — but syncs are landing` | A cron entry / hand-written unit is driving it | Nothing |

The check is local to the machine running the CLI, so it is omitted when
`--target` points at a remote instance.

Driver logs: `~/.flair/logs/federation-sync.{stdout,stderr}.log`.

## Security

### Signed requests

Every federation request (pair, sync) is signed with the sender's Ed25519 private key. The receiver verifies the signature against the peer's pinned public key. Unsigned or tampered requests are rejected with 401.

The signature covers the canonical JSON of the request body (keys sorted recursively, signature field excluded).

### Encrypted key storage

Private key seeds are stored in `~/.flair/keys/<instanceId>.key`, encrypted with AES-256-GCM. The encryption key is derived via HKDF from:

1. `FLAIR_KEY_PASSPHRASE` environment variable (recommended for production), or
2. An auto-generated random passphrase at `~/.flair/keys/.passphrase` (mode 0600)

If neither the env var nor the passphrase file can be accessed, federation identity creation fails. Private keys are never stored in the database.

### Pairing tokens

New peers must present a valid, unexpired, unused pairing token. This prevents unauthorized instances from joining the federation. Tokens are generated by the hub admin and are single-use.

Re-pairing an existing peer (same instance ID, same public key) does not require a token.

### Originator enforcement

Spoke instances can only push records they originated. A spoke cannot overwrite records from another spoke or from the hub. The hub can relay records from any origin.

### Per-record signatures and principalId

Each pushed record carries an Ed25519 signature over a versioned canonical body. `v` lives inside that body so versions are distinguishable: a `v: 1` signature cannot verify as `v: 2`.

- **`v: 1` (today's wire):** signed fields are `{ v, table, id, data, updatedAt, originatorInstanceId }`. Senders did not put `v` on the wire; receivers default absent `v` to `1`. `principalId` may appear on the record (from a Memory provenance stamp) but was not in the signed field set.
- **`v: 2`:** `principalId` is included in the signed payload when the row has a write-time provenance stamp (`provenance.verified.agentId`). `v` is on the wire.

On apply, after the signature checks, **Memory** (the only principal-owning federated table) requires `principalId` to be present and equal to `data.agentId`. Absent is a skip (`principal_mismatch`), not an accept. Soul, Agent, and Relationship are not in that set and still sync without a principal.

Receivers must be upgraded before senders. A Phase 1 receiver verifies both shapes in one batch. Old receivers cannot reconstruct a `v: 2` body and will skip those records (per-record, not a batch outage) until they upgrade. Optional `FLAIR_FEDERATION_REQUIRE_RECORD_PRINCIPAL=true` skips leftover `v: 1` Memory records that lack `principalId` once the fleet is on `v: 2`.

### Timestamp ceiling

Records with `updatedAt` more than 5 minutes in the future are rejected. This prevents an attacker from using far-future timestamps to permanently win last-write-wins (LWW) merge conflicts.

## CLI Reference

| Command | Description |
|---------|-------------|
| `flair federation status` | Show instance identity, peer connections, and whether anything is driving sync |
| `flair federation pair <hub-url> --token-from <file>` | Pair this spoke with a hub using a token triple file (or `-` for stdin) |
| `flair federation sync` | Push local changes to the hub (one-shot) |
| `flair federation sync enable [--interval <s>] [--admin-pass-file <path>]` | Install the scheduled sync driver (launchd on macOS, systemd timer on Linux) |
| `flair federation sync disable [--remove-shim]` | Remove the scheduled sync driver |
| `flair federation sync status` | Show whether the driver is installed and genuinely active |
| `flair federation watch [--interval <s>]` | Run sync in a foreground loop for an interactive session (default 30s) |
| `flair federation reachability` | Probe local instance + each paired peer (read-only) |
| `flair federation token [--ttl <min>]` | Generate a one-time pairing token triple (hub only) |

## Conflict Resolution

Federation uses record-level last-write-wins (LWW) with ISO timestamp comparison. When two instances modify the same record, the one with the later `updatedAt` wins. Field-level LWW is planned for a future version.

## Troubleshooting

### config.yaml port drift

If the hub's configured port in `config.yaml` differs from the port the spoke is targeting, federation requests fail with a connection error. Verify the port matches between the spoke's pair URL and the hub's `config.yaml` (`federation.port` or the instance's listen port).

```bash
# On the hub, confirm the listening port
grep -E 'port|federation' ~/.flair/config.yaml
```

### Local FederationInstance fetch needs auth

When troubleshooting on the hub, fetching `/federation/instances/<id>` locally (e.g. via `curl localhost`) may return a 401 if the request does not carry the authentication headers the platform layer expects. On Fabric this gate is enforced even on localhost. Use the CLI tooling (`flair federation status`) instead of raw HTTP calls for local inspection.

### `flair_pair_initiator` role not found on hub

If pairing fails with a role-not-found error, the hub instance may be missing the `flair_pair_initiator` role. This role is created automatically during `flair init --remote` but can be lost if the database was reset or migrated manually. Re-run `flair init --remote` on the hub to restore default roles, then retry pairing.

### Bootstrap user not deleted on Fabric

After a successful pairing, the temporary bootstrap user is automatically deleted. If it persists on a Fabric deployment, check that the hub's Harper operations log does not show a rollback or permission error during the cleanup step. Manually removing the stale bootstrap user via the Harper Studio is safe if needed — it is never used after pairing completes.

### Stale Peer record on spoke

If a spoke was previously paired with a different hub (or the hub's identity key changed), the spoke may retain a stale `Peer` record pointing to the old hub. Remove the stale record before pairing with the new hub:

```bash
# Show current peers
flair federation status

# Remove a specific peer (replace <instanceId>)
flair federation unpin <instanceId>
```

## Limitations (1.0)

- **HTTP push only** — no persistent WebSocket connections or real-time sync
- **Polled sync** — `flair federation sync enable` schedules a periodic one-shot (launchd / systemd, default 300s); there is no write-path trigger, so a new memory replicates on the next tick rather than immediately
- **Single hub** — spoke-to-spoke sync goes through the hub
- **Record-level LWW** — not field-level; concurrent edits to different fields of the same record may lose data
