# Federation

Hub-and-spoke sync between Flair instances. A hub instance coordinates sync for one or more spoke instances.

## Overview

Federation lets multiple Flair instances share memories, relationships, and agent records **in one direction per call**. Each instance maintains its own Ed25519 identity. Sync requests are signed and verified against pinned peer public keys. A push omits private memories — see [What a push sends](#what-a-push-sends).

```
Spoke A ──[POST /FederationSync]──▶ Hub
Spoke B ──[POST /FederationSync]──▶ Hub
```

There is no hub → spoke arrow and no pull path. `FederationSync` declares `post()` only.

- **Hub:** accepts signed sync pushes from paired spokes. It does not push records back, and it does not expose a pull endpoint.
- **Spoke:** pushes local changes to the hub. It receives nothing back.

**Sync is push-only — one direction per call.** A spoke that needs hub (or other-spoke) data has no supported path today. The honest options:

1. **No downward path.** Do not plan on reading another instance's memories through the hub.
2. **Mutual pairing.** For records both ways, each instance pairs **as a spoke of the other** — two pairings, two tokens, two syncs. Same workaround as [deploying-on-fabric.md](deploying-on-fabric.md#federation-is-push-only) and [embedding-in-a-harper-app.md](embedding-in-a-harper-app.md#federation).
3. **Roadmap.** Deliberate hub-authorised downward flow is tracked in [#1452](https://github.com/tpsdev-ai/flair/issues/1452) (design) and the design frame on [#934](https://github.com/tpsdev-ai/flair/issues/934). This page does not claim that capability.

The `direction: "pull"` field written to `SyncLog` on the hub is the hub logging that *it received a push*. It is not a spoke fetching.

## Pairing a New Spoke (Bootstrap-User Flow)

Pairing connects a spoke to a hub with mutual key pinning and an auth-aware handshake that works across all Harper topologies, including Harper Fabric.

### Step-by-step

**1. Hub admin generates a pairing token triple**

On the hub machine, the admin runs `flair federation token`. The command emits a JSON triple containing a one-time bootstrap credential:

```bash
flair federation token --admin-pass-file ~/.flair/admin-pass
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
flair federation pair <hub-url> --admin-pass-file ~/.flair/admin-pass --token-from /path/to/triple.json

# From stdin
cat triple.json | flair federation pair <hub-url> --admin-pass-file ~/.flair/admin-pass --token-from -
```

**4. Behind the scenes**

- The bootstrap user authenticates at the platform layer (works on standalone deployments and Harper Fabric alike).
- The resource handler validates the pairing token, the signed request body, and the binding between the bootstrap user and the token.
- On success the hub creates a `Peer` record for the spoke and removes the temporary bootstrap user. The spoke records the hub as its peer.

After pairing, both instances pin each other's Ed25519 public keys and are ready to sync.

## Why the Bootstrap-User Flow?

Earlier designs relied on `allowCreate=true` combined with body-only authentication. That approach works on single-component deployments but breaks on Harper Fabric, where the platform authentication gate fires before the resource handler sees the request. The bootstrap-user flow (Option B) makes the pair handshake auth-aware so it operates correctly on all Harper topologies: standalone, Fabric single-node, and Fabric multi-node.

## Fabric Pairing Example

A managed Harper Fabric hub has no shell. Mint the triple from any machine that can reach it, then pair from the spoke. The `--admin-pass-file` on that mint is the **hub/cluster** admin (the admin file on the hub host, or a secret manager), not the spoke's `~/.flair/admin-pass`. `--admin-pass-file` reads the password in-process (mode 0600 enforced) so it stays out of shell history and the process list; `--admin-pass` is also accepted but lands in both, and `FLAIR_ADMIN_PASS` suits CI. The full bring-up, including why `--ops-target` names port 9925, is [spoke-bringup.md §5a](spoke-bringup.md#harper-fabric-hub-no-shell). <!-- docs-freshness-allow: Fabric ops API port, not legacy data port -->

```bash
# 1. On any machine (the spoke itself is fine) — no ssh, no scp.
# umask 077 sets the mode of a file the redirect CREATES; set -C makes the redirect
# refuse to overwrite an existing one, so a retry cannot truncate-and-reuse a looser file.
# /path/to/hub-admin-pass is a 0600 file holding the HUB admin password, not ~/.flair/admin-pass on this machine.
(umask 077; set -C; flair federation token --admin-pass-file /path/to/hub-admin-pass \
  --target https://<hub>.<org>.harperfabric.com \
  --ttl 60 \
  --ops-target https://<hub>.<org>.harperfabric.com:9925 > ./pair-triple.json)  # docs-freshness-allow: Fabric ops API port, not legacy data port

# 2. On the spoke — the SPOKE admin password (its own ~/.flair/admin-pass) writes the local Peer row; the mint above used the hub admin
flair federation pair https://<hub>.<org>.harperfabric.com \
  --admin-pass-file ~/.flair/admin-pass \
  --token-from ./pair-triple.json
```

Replace `<hub>` and `<org>` with your actual values, and point `/path/to/hub-admin-pass` at a 0600 file holding the hub admin password on the minting machine. The pair step's admin password is the spoke's, used to write the local Peer row.

Running the hub on Fabric has its own considerations — port derivation against a managed
`443` endpoint, why the sync driver can only be installed on a machine you control, and
the observability limits of a node you have no shell on. See
[`docs/deploying-on-fabric.md`](deploying-on-fabric.md).

## Sync

Push local changes to the hub, once:

```bash
flair federation sync --admin-pass-file ~/.flair/admin-pass
# Output: ✅ Synced 12 records (0 skipped) in 145ms
```

`sync` and `verify` take the admin password from `--admin-pass-file` (an owner-only
file, mode 0600 enforced). In CI, where a file is awkward, set `FLAIR_ADMIN_PASS`
instead: an explicit `--admin-pass-file` or `--admin-pass` overrides it, and giving
both the file and `--admin-pass` is a usage error. Avoid `--admin-pass` itself — it
lands in shell history and the process list.

### What a push sends

Each sync considers rows changed since the cursor from four tables: `Memory`, `Soul`, `Agent`, and `Relationship`. With `FLAIR_FEDERATION_PRESENCE_SEND` enabled (default off), `Presence` is scanned after those tables. Only Presence rows whose `originatorInstanceId` is this instance are eligible. Selection uses the later of `lastHeartbeatAt` and `activityUpdatedAt` against a separate watermark, clamped to scan time, with a 30 s overlap. A hub requires `FLAIR_FEDERATION_PRESENCE_RECEIVE` (default off) to store pushed Presence.

**Memory rows with `visibility` exactly `"private"` are left behind.** Durability is not the filter. `"shared"` and any other present value are included. Soul, Agent, and Relationship have no `visibility` field, so this rule does not apply to them.

A Memory row with **no `visibility` field still syncs, on purpose.** Those rows were written before the field existed. The push uses the same predicate as cross-agent read (`resolveReadScope` in `resources/memory-read-scope.ts`): only the literal string `"private"` is private. Missing, `null`, and anything else stay non-private so pre-field rows keep replicating exactly as they did. That is the migration rule, not a hole in the filter.

Private means owner-only on this instance. A peer that received the row would hold a copy other agents on that instance could read. Holding the row back is the point of `private`.

Durability still explains a count gap that is entirely `standard` rows. When a write omits `visibility`, the server defaults it from durability: `permanent` and `persistent` become `shared`; `standard`, `ephemeral`, and an omitted durability become `private`. A standard memory therefore stays on the spoke unless the writer set `visibility` to `shared`. Ephemeral memories are private-only at write time, so they never federate. That is the default and the ephemeral constraint, not a second filter and not loss of memories that were stored as shared.

`flair federation verify` writes its canary as `durability: "standard"` and `visibility: "shared"` for this reason. When every changed Memory row was withheld, sync says they were held back for private visibility instead of reporting that nothing changed.

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

### Did the canary actually land?

`flair federation verify` writes a tagged memory, **pushes it** (so a
freshly paired spoke with no sync daemon can still pass), then probes each
peer. It uses the same couldn't-check-≠-failed split as `flair fleet verify`
(flair#988 / #823):

| What the probe saw | Verdict | Exit |
|---|---|---|
| Canary found | OK | 0 |
| HTTP 401/403, unreachable, or no endpoint | UNVERIFIABLE (warning) | 0 |
| Reachable peer answered 200 without the canary after a successful push | FAIL | 1 |
| Revoked peer | UNVERIFIABLE (warning; not probed) | 0 |

A 401 is "could not authenticate to that peer," not "sync failed." Do not
treat unverifiable as a pass that hides a reachable peer on the wrong side
of the canary.

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

### What `connected` means

`federation.peers.connected` counts **recent contact** — a peer whose
`lastSyncAt` sits inside the staleness window. `lastSyncAt` is the spoke's
outbound sync cursor: it is stamped after a successful sync batch or a
successful no-change liveness ping, and `federation sync` re-sends from it, so a
frozen cursor re-sends from the frozen point on every poll.

`connected` is **not** a verified hub identity and **not** pull readiness.
Inbound federation separately verifies each request against the peer's pinned
public key, so a peer row whose stored key is missing still reads `connected`
when it has synced recently — that is correct under this definition. A missing
key is a `connected`-but-unauthenticated state, repaired by re-pairing, never
silently trusted.

The cursor stamp is written as a field-only update of the peer row (only
`lastSyncAt` and `updatedAt`), so it cannot revert a concurrent key repair or
revocation, and it never inserts a row that is not there.

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

New peers must present a valid, unexpired, unused pairing token. This prevents unauthorized instances from joining the federation. Tokens are generated by the hub admin and are single-use on one node.

An otherwise valid re-pair of a non-revoked peer (same instance ID, signed with the peer's pinned public key) requires no token; a supplied token must pass validation before the transactional Peer re-read and is consumed only if the pairing commits. Before writing, the re-pair rechecks the pinned key and revoke status inside its owned transaction: a different key is refused (409); otherwise a revoked peer is refused (403 `peer_revoked`), with no peer row written and no token consumed. A peer row absent at that re-read is paired as a first-time pair with a valid token; without a token the request is refused (401). On the token path, the re-read covers changes committed before the transaction's first read (its token read), not changes committed after it. A pair request whose first read finds no peer row (a first-time pair) stages its peer row in the owned transaction that consumes its token, then re-reads the committed peer row before that transaction commits. If that confirm read finds a row for the instance in committed state although the first read returned none, the pair is refused (409 `peer_row_appeared`): the request writes no peer row and the token stays unconsumed. The confirm reports a row present when it runs, not when that row was committed; it also detects a row committed after the token read, if that row is still present. A row committed after the confirm read and before the commit is not seen by it.

### Originator enforcement

Spoke instances can only push records they originated. A spoke cannot overwrite records from another spoke or from the hub. The hub can accept a pushed record that originated on any instance. That is receive-side originator policy on a push, not a hub-to-spoke delivery path.

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
| `flair federation verify [--wait <s>] [--admin-pass-file <path>]` | Write a canary, push it, and check each peer. Flag/file admin credentials authenticate the admin-gated peer listing. 401/403, unreachable, and revoked are UNVERIFIABLE (warning, exit 0); a reachable peer missing the canary still FAILs (exit 1). |
| `flair federation reachability` | Probe local instance + each paired peer (read-only) |
| `flair federation token [--ttl <min>]` | Generate a one-time pairing token triple (hub only) |

## Conflict Resolution

Federation uses record-level last-write-wins (LWW) with ISO timestamp comparison. When two instances modify the same record, the one with the later `updatedAt` wins. Field-level LWW is planned for a future version.

### A pending agent key is never completed by federation

`POST /AgentKeyRegister` checks a fresh row is non-deactivated, local and `pending` and
confirms it before commit (see [registration limits](api-reference.md#identity--agent-presence-soul)); the administrator
operations API can also write the column directly (the documented admin
trust-root path). Federation cannot complete it. A record that reaches the merge
plan with `publicKey` different from stored `pending` is skipped whole as
`agent_pending_key_not_federated`, unless the status rule refused it first as
`agent_status_not_federated`. Earlier validation keeps its own reason, such as
`future_timestamp` (see [docs/api-reference.md](api-reference.md#federation)).

Peer non-convergence is the consequence for a copy B already holds. Registration
writes only A's local tables; when B already holds a pending copy and A's
registered-key row later reaches B through a sync, the skip rule leaves that copy
exactly `pending`. Sync alone therefore does not converge that copy. Whether B's
own `POST /AgentKeyRegister` can complete it depends on how B's copy was created:
B stamps sync provenance on a row it receives through a sync, and a copy that
carries sync provenance (or whose `originatorInstanceId` names another instance)
is refused there as `agent_not_local`. A pending copy created locally on B, with
neither marker, is a local agent: B's own registration can complete it. For a
sync-originated or foreign-home copy, the two instances do not converge on one
key: syncing A's registered-key row cannot complete B's pending copy, and that
key needs direct action on B. The remedy is on B, for
a sync-originated or foreign-home copy: B's administrator writes the agent's
public key (the one registered on A) onto B's copy through B's operations API,
an `update` of `flair.Agent` with `{id, publicKey, updatedAt}`. That is the raw
write `flair agent rotate-key` makes, but `rotate-key` generates a new keypair,
so B's copy would then hold a different key from A's. A B row that is absent
can receive A's registered-key row: the pending-key guard applies only to a row B
already holds with `publicKey: "pending"`.

### An agent's key, home and admin authority in a sync

An existing Agent row's `publicKey` and home (`originatorInstanceId`) change
through a sync only when the batch's signing sender is the row's stored home. A
record from another peer that would change either is skipped whole as
`agent_identity_not_from_home`. Earlier checks, including the status and
pending-key rules, keep their own reasons. A row with no stored home takes
neither change from a peer; the receiving instance's administrator can write
those fields through its operations API.

Admin authority is not taken from a peer: a new row is stored without
`role: "admin"` or `admin: true`, and an existing row keeps its stored `role` and
`admin` when the record's would change its admin state.

## Troubleshooting

### Listen port drift

There is no `federation.port` key. Federation uses the hub's HTTP listen port. The spoke's pair URL has to use that port.

On the hub, the listen port Harper last bound is `http.port` in the instance data directory (default `~/.flair/data/harper-config.yaml`). A default install also records a top-level `port:` in `~/.flair/config.yaml`. That file's port keys are `port` and `opsPort` only.

```bash
# On the hub. `http.port` is host-qualified, for example 127.0.0.1:19926.
grep -A2 '^http:' ~/.flair/data/harper-config.yaml
grep -E '^(port|opsPort):' ~/.flair/config.yaml
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

HTTP paths (`/FederationPair`, `/FederationSync`, `/FederationInstance`,
`/FederationPeers`) and the Instance / Peer / PairingToken / SyncLog / ReplayNonce
schemas: **[docs/api-reference.md](api-reference.md#federation)**.

## Limitations (1.0)

- **HTTP push only** — no persistent WebSocket connections, no real-time sync, and no pull endpoint
- **Polled sync** — `flair federation sync enable` schedules a periodic one-shot (launchd / systemd, default 300s); there is no write-path trigger, so a new memory replicates on the next tick rather than immediately
- **Single hub, one-way** — spokes push to one hub; there is no spoke-to-spoke path and no hub-to-spoke pull
- **Record-level LWW** — not field-level; concurrent edits to different fields of the same record may lose data
