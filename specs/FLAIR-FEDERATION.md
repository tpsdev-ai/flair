# Flair Federation

## Status
- **Owner:** Flint
- **Priority:** P1 — foundational to 1.0 (standalone hosted topology depends on this being designed correctly)
- **Context:** Design session with Nathan 2026-04-07; Kern architecture review 2026-04-08
- **Reviewers:** Kern (architecture, briefed before draft and incorporated in this version), Sherlock (security — pending review)
- **Composes with:** FLAIR-PRINCIPALS, MEMORY-MODEL-V2, FLAIR-WEB-ADMIN

## Summary

Flair 1.0 must support two deployment topologies as first-class:

1. **Federated (hub-and-spoke)** — one hosted Flair instance on Harper Fabric serving as the **hub**, with local Flair instances on rockit and VMs (tps-anvil, future VMs) as **spokes**. Each spoke dials outbound WSS to the hub. Spokes do not peer with each other directly in 1.0; cross-spoke data propagates through the hub as a two-hop path.
2. **Standalone hosted** — a single Flair instance running on Fabric, complete by itself. No spokes.

Both run the same Flair codebase. The difference is configuration and whether peers are declared. This spec defines the federation layer — how Flair instances establish trust, exchange records, handle conflicts, and stay consistent over an unreliable WAN link.

**Why Fabric is the hub and not rockit.** A hub "machine deep in a private network" doesn't work because spokes can't reach it inbound. The hub must be publicly reachable so spokes can dial outbound to it. Fabric satisfies that by design (it's the managed, always-on node with a public TLS endpoint). Rockit sits behind NAT and should never be asked to accept inbound connections from the internet. Spokes (rockit, VMs) all initiate outbound. Hub (Fabric) accepts.

Key constraints driving the design:

- **Spokes are not publicly reachable.** rockit and VMs are behind NAT or otherwise not inbound-addressable. All peer connections initiate outbound from spokes to the hub.
- **Tunnels are off the table for the sync link.** No Tailscale, Cloudflare Tunnel, or reverse SSH for the hub ↔ spoke sync channel. Sync runs on a single persistent authenticated WebSocket over TLS directly to the hub's public endpoint. (This does not preclude tunnels elsewhere in the deployment — e.g., legacy VM-to-rockit tunnels for clients of rockit's Flair.)
- **Harper Pro replication is unusable.** Source-available license conflicts with our open-source positioning. Sync must live at the Flair application layer.
- **The hub runs on Harper Fabric with no CLI access.** All operations on the hub happen via Harper's operations API (via `harper set_configuration` and similar), via sync traffic from a paired spoke, or via the web admin UI (FLAIR-WEB-ADMIN).
- **"Nathan-grade" reliability.** Every visible failure mode must have a designed recovery path. "Restart it" is not a valid answer.
- **No secrets manager on Fabric.** Harper Fabric does not provide dedicated secret storage. Sensitive runtime values are either baked into Harper's configuration (via `harper set_configuration`) or stored in Harper blobs (encrypted at rest where needed). Private keys must not appear in logs or config files that could be inspected by platform operators.

---

## 1. Concepts

### Topology: hub-and-spoke

1.0 uses a hub-and-spoke federation pattern, with Harper Fabric as the hub:

```
                    Fabric (public, always-on, the hub)
                         ↑       ↑         ↑
                         |       |         |
                    rockit   tps-anvil   future-vm
                    (spoke)   (spoke)    (spoke)
```

- **Hub:** exactly one Flair instance running on Harper Fabric with a public `wss://` endpoint.
- **Spokes:** any number of Flair instances on private machines (rockit, tps-anvil, future VMs) that dial outbound to the hub's WSS endpoint.
- **Spokes don't peer with each other** in 1.0. Cross-spoke records propagate via the hub (rockit writes → rockit syncs to Fabric → Fabric syncs to anvil).
- **Each instance maintains its own Flair deployment** — own Harper Core, own data, own memory, own principals. Cross-spoke independence means if the hub goes down, each spoke operates fully locally; only cross-spoke synchronization pauses.

Full mesh (spoke-to-spoke direct connections) is reserved for 2.0. It would reduce cross-spoke latency and eliminate the hub as the coordination choke point, but it adds N×(N-1)/2 connection complexity and doesn't solve any 1.0 problem.

### Instance identity

Each Flair instance has its own **Instance Identity** — an Ed25519 keypair distinct from any agent or human principal. The instance keypair authenticates the instance to its peers; it does **not** sign individual memory records.

```typescript
interface InstanceIdentity {
  id: string;                    // "flair_h82kx9" — generated on first boot
  publicKey: string;             // Ed25519, base64url
  createdAt: string;
  // Private key storage:
  //   Harper Core hosts (rockit, VMs):
  //     Stored in a Harper blob record under a fixed key (e.g., "instance:ed25519:private").
  //     Harper blobs are persistent across restarts and local to the host.
  //   Harper Fabric (the hub):
  //     Also stored in a Harper blob. Harper handles blob persistence and replication.
  //     Encrypted at rest via a key derived from a deploy-time configuration value
  //     set via `harper set_configuration flair.instance_key_passphrase=...`
  //     (not present in stdout or source code). See § 7.3.
}
```

**Why a separate identity:** instance-level auth protects the WSS channel between peers. Per-record signatures (from the originating Principal) protect the integrity of individual memory writes. These are two different trust layers and they must not be conflated — a compromised peer should only be able to inject records for principals it controls, never for principals owned by the other peer.

**Why instance keys are acceptable on Flair** (clarification vs. human-principal keys, which are NOT stored on Flair — see FLAIR-PRINCIPALS): the instance key is a deployment artifact that the instance must possess to do its job as a peer. Losing it means losing the ability to authenticate to other instances, which is a bounded outage (pair again with a new key). It is not a user-controlled identity and its compromise doesn't expose user data directly. User-controlled cryptographic material (passkey private keys, which never leave the authenticator anyway; any per-human Ed25519 keys, which we chose not to have) stays out of Flair entirely.

### Peer record

Each Flair instance maintains a list of peers it has paired with:

```typescript
interface Peer {
  id: string;                    // remote instance id
  publicKey: string;             // pinned at pairing time, must match on reconnect
  endpoint: string;              // wss://flair.lifestylelab.io/sync
  addedAt: string;
  lastConnectedAt: string | null;
  lastSyncedSequence: Record<string, number>;  // principalId → last seen seq
  status: "active" | "paused" | "revoked";
  // Selective sync configuration
  subjectSubscriptions: string[] | "all";
  syncPrivate: false;            // hard-wired false — private memories never sync
}
```

**Peer count limits for 1.0:**
- The **hub** maintains one Peer record per spoke. N spokes = N peer records. All peer records follow the same rules; the hub just has multiple active sync channels simultaneously.
- Each **spoke** maintains exactly one Peer record — the hub.
- Spoke-to-spoke peer records are forbidden in 1.0. The schema supports them but the configuration validator rejects any spoke that tries to pair with another spoke.

### SyncFrame

A SyncFrame is the unit of cross-instance data transfer. Every create/update/delete operation on a record that is eligible for sync produces exactly one SyncFrame.

```typescript
interface SyncFrame {
  protocolVersion: 1;             // reserved for future binary pivot; see § 5.3
  frameId: string;                // UUID, sender-generated
  senderInstanceId: string;       // who is sending THIS frame (not the originator)
  senderSequence: number;         // per-principal monotonic sequence from sender
  originatorPrincipalId: string;  // who originally wrote the record
  recordType: "memory" | "principal" | "credential" | "grant" | "soul";
  operation: "upsert" | "tombstone";
  recordId: string;
  recordPayload: unknown;         // schema depends on recordType; see §§ 4, 5
  lamport: number;                // Lamport clock value at the time of the write
  signature: string;              // Ed25519 signature over the frame by the ORIGINATOR, not the sender
}
```

Three signatures conceptually guard a SyncFrame:

1. The **WSS channel** is authenticated by the instance identity (`senderInstanceId` → pinned `publicKey`).
2. The **SyncFrame itself** carries an Ed25519 signature from the **originating principal**, not the sender. This is what enforces signature-to-principal binding (§ 6.1).
3. The **record payload** may contain further signatures depending on type — for example, a memory record already has its own per-agent signature in Flair's data model; the SyncFrame wraps and does not replace it.

The distinction between `senderInstanceId` (the peer that's delivering the frame right now) and `originatorPrincipalId` (who originally wrote the record) is critical: a frame being relayed by an instance it wasn't originated on is common in normal sync operation, and the receiving instance must verify provenance against the **originator's** signature, not the sender's.

### Per-principal sequence numbers

Each principal's writes are assigned a monotonically increasing sequence number **per originating instance**. Catch-up state is tracked per `(principalId, originatingInstanceId)` pair:

```
lastSyncedSequence: {
  "agent_flint": { "flair_rockit_a1b2": 1057 },
  "agent_kern":  { "flair_rockit_a1b2": 412 },
  "usr_nathan":  { "flair_rockit_a1b2": 88, "flair_hosted_h82k": 12 },
}
```

Reasoning (per Kern's review): vector clocks scale with the number of nodes, which is fine for our N=2 case, but they don't efficiently support the selective-sync model where a peer may only want some principals or some subjects. Per-principal sequence numbers let the receiver ask the sender "give me everything from `agent_anvil` after sequence 402," which maps cleanly to subject subscription.

### Lamport clocks for memory records

For ordering conflicts within the supersede chain of a memory record, LWW-by-wallclock is inadequate — clocks drift and ties are unpredictable. Memory records therefore carry a **Lamport clock** value derived from the standard algorithm:

- On any local write: `lamport = max(current_lamport, lastSeenLamport) + 1`
- On receiving a SyncFrame: `current_lamport = max(current_lamport, frame.lamport)`
- Tie-break between equal lamport values: deterministic by `(originatorPrincipalId, recordId)` lexicographic comparison

Lamport ordering governs the supersede chain — "which memory supersedes which" resolves deterministically regardless of wallclock.

---

## 2. Bootstrap & Pairing

All user-facing operations in this section happen through the Flair CLI, which wraps Harper CLI internally. Users never type `harper deploy`, `harper set_configuration`, or any other Harper command directly. See **FLAIR-CLI.md** for the canonical command surface. This spec describes what happens under the hood.

### Instance cold start

On first boot of a Flair instance (detected by absence of the instance Harper blob containing the private key), the following happens automatically — either triggered by `flair init` (local mode) or by `flair deploy --target fabric://...` (hosted mode). The user does not see these steps individually; they see one success indicator.

1. Generate an Ed25519 keypair.
2. Generate a random instance id (`flair_<12 random base62 chars>`).
3. Read the instance key passphrase from Harper configuration at `flair.instance_key_passphrase`. For local installs the passphrase was written there by `flair init` after auto-generating it and storing in the local OS keychain. For Fabric deploys it was written by `flair deploy` via `harper set_configuration` after auto-generating and storing in the local OS keychain. In both cases the passphrase lives in the deploying machine's keychain; Flair only sees it through Harper config.
4. Derive a symmetric key from the passphrase (Argon2id → AEAD).
5. Encrypt the Ed25519 private key with the symmetric key.
6. Store the encrypted private key in a Harper blob record under the key `instance:ed25519:private`. Store the public key under `instance:ed25519:public` (unencrypted).
7. Store the instance id in Harper configuration at `flair.instance_id` for diagnostic lookup.
8. Expose the public key via `GET /instance-identity.json` (unauthenticated — the public key is public by definition).
9. **Never log the instance private key, the passphrase, or any secret to stdout.** Harper Fabric surfaces stdout to platform operators; treat stdout as a semi-public audit trail.
10. Start the HTTP listener, OAuth endpoints, memory resources, and the `/sync` WebSocket endpoint.
11. If `flair.role` config is unset or `"standalone"`, the instance is complete.
12. If `flair.role = "hub"`, accept inbound `/pair` attempts but do not initiate connections.
13. If `flair.role = "spoke"` with `flair.hub_endpoint` set, begin dialing outbound to the hub.

### Pairing a spoke to a hub — the user-facing flow

The entire pairing flow collapses to one command on the spoke side. This is the Nathan-grade UX target — one success/failure, no token handling, no shell variable juggling.

```bash
# On rockit (or any other spoke machine)
flair pair add --hub wss://<cluster>.harper.fabric/sync
```

That's it. The user sees:

```
Pairing with wss://<cluster>.harper.fabric/sync...
  ✓ Generated bootstrap token
  ✓ Pushed token to hub config
  ✓ Completed pair handshake
  ✓ Pinned hub public key
  ✓ Opened sync channel

This spoke is now paired with the hub. Sync will begin immediately.
```

### What the Flair CLI does under the hood

When `flair pair add --hub <endpoint>` runs on the spoke:

1. **Read Fabric credentials** from the local OS keychain (stored earlier by `flair remote login <target>`). If not present, print a clear error telling the user to run `flair remote login` first.
2. **Generate a bootstrap token locally** — 32 random bytes, base62-encoded. The token exists only in the CLI process memory for the duration of this command.
3. **Push the token to the hub via Harper CLI wrapping:**
   - Shell out to: `harper set_configuration target=<hub-url> username=<u> password=<p> flair.pending_bootstrap_token=<token> flair.pending_bootstrap_expires_at=<now+15min>`
   - The Harper CLI is invoked as a subprocess; its stdout is captured and suppressed from the user unless an error occurs (progress output comes from Flair CLI's own step log).
4. **POST to the hub's `/pair` endpoint** over HTTPS (not WSS — pairing is a one-shot HTTP handshake). The POST body contains: the bootstrap token (as proof), the spoke's instance id, and the spoke's Ed25519 public key.
5. **Hub validates** the token against `flair.pending_bootstrap_token`, verifies it hasn't expired, and responds with its own instance id + public key.
6. **Both sides pin each other's public keys** in their Peer tables (spoke's side: save hub's key; hub's side: save spoke's key).
7. **Hub clears the bootstrap token** via its own internal `set_configuration` call. Token cannot be reused.
8. **Spoke writes the hub to `~/.flair/config.yaml`** under `peers[]`.
9. **Spoke opens the WSS sync channel** at the hub's `/sync` endpoint using the now-pinned hub identity, initiates catch-up.
10. **CLI prints success** and exits.

At no point does Nathan type the token. At no point is the token displayed. At no point is a Harper command visible to Nathan. The token's entire lifetime is: generated in the spoke CLI's memory → pushed to hub config → consumed by the pair handshake → cleared. Roughly 2 seconds end-to-end under normal network conditions.

### Pairing flow — standalone hosted

For the standalone hosted topology (hub only, no spokes), pairing is skipped entirely. `flair deploy --target fabric://...` produces a complete instance with `flair.role = "standalone"`. If Nathan later decides to add a spoke, he runs `flair pair add --hub <that-hub>` from the new machine — the hub doesn't need to do anything different; it just accepts a new `/pair` request the same way it would have accepted the first one.

### Pairing flow — hub bootstrap (the cold start case)

When Flair is first deployed to Fabric as a hub via `flair deploy --target fabric://... --role hub`, the deploy command itself handles the initial configuration:

1. Flair CLI reads Fabric credentials from keychain.
2. Flair CLI generates the instance key passphrase (random, high-entropy) and stores it in the local keychain under `ai.lifestylelab.flair.instance_passphrase_<cluster>`.
3. Flair CLI calls `harper deploy project=flair package=<vendored-path> target=<cluster> ...`.
4. After deploy completes, Flair CLI pushes the passphrase to Fabric config via `harper set_configuration flair.instance_key_passphrase=<value>`.
5. Flair CLI calls `harper restart_service` to cycle Flair with the new config.
6. Flair CLI polls the hub's `/instance-identity.json` endpoint until it returns 200 with a public key — that's the success signal.
7. Flair CLI writes the cluster details to `~/.flair/config.yaml` as the known remote target.
8. Flair CLI prints next-step guidance: "Your Flair hub is live at https://<cluster>.harper.fabric. Pair spokes with `flair pair add --hub wss://<cluster>.harper.fabric/sync` from each spoke machine."

The hub is now ready. Nathan goes to each spoke machine and runs one `flair pair add` command. Each pair takes seconds.

### Bootstrap token properties

- **Single use.** Consumed and cleared from Harper configuration on first successful pair exchange.
- **Short TTL.** 15 minutes, enforced via `flair.pending_bootstrap_expires_at` configuration value.
- **High entropy.** 32 random bytes, base62-encoded.
- **Never logged.** Not in stdout, not in Harper audit logs, not in shell history.
- **Lives only in process memory on the spoke during pairing.** The spoke's Flair CLI generates the token, holds it in a local variable, pushes it to the hub via `harper set_configuration`, presents it to the hub's `/pair` endpoint, then discards the local copy and relies on the hub to clear its config copy.
- **Hub-side storage is hashed.** The hub hashes the token as soon as `set_configuration` writes it, replacing the plaintext via a follow-up `set_configuration` call during its own startup sequence. Between the initial `set_configuration` and the hash replacement (milliseconds to seconds), a Harper config snapshot could capture the plaintext — this is the only window where plaintext exists at rest. After that, only the hash exists.
- **Single outstanding token per hub.** Pushing a new token overwrites the previous one.
- **Idempotent retries.** If `flair pair add` fails mid-flow (network error between steps 3 and 5, for example), running it again generates a new token, overwrites the previous config value, and starts over. The user retries one command; they don't unwind half-completed state manually.

### Schema version check in the handshake

Before any records flow, the two instances exchange a handshake frame:

```json
{
  "protocolVersion": 1,
  "instanceId": "flair_rockit_a1b2",
  "schemaVersion": "2026-04-08",
  "capabilities": ["selective-sync", "lamport-clocks", "principal-v2"],
  "signature": "<ed25519 over the above>"
}
```

If the `schemaVersion` values disagree:
- Both sides log the mismatch
- The channel moves to **Passive Wait** state: connection stays open but no records are exchanged
- The side with the **older** schema logs a recommendation to upgrade
- The channel remains in Passive Wait until both sides agree on a version

Per Kern: cross-version sync is explicitly not supported in 1.0. Attempting to replicate schema-mismatched records risks corruption that's hard to roll back. Safer to block until aligned.

---

## 3. The Sync Channel

### Transport

- **WebSocket over TLS** (`wss://`) on the hosted side.
- **rockit dials outbound** — connection is always initiated by rockit because rockit is not publicly reachable.
- **One persistent connection per peer pair.** No pooling, no multiplexing.
- **Automatic reconnect** with exponential backoff (1s, 2s, 4s, 8s, capped at 60s) on disconnection.

### Connection states

```
DISCONNECTED
    ↓ (dial)
CONNECTING
    ↓ (TLS established)
HANDSHAKING
    ↓ (handshake exchange + schema match)
CATCHING_UP
    ↓ (both sides caught up)
STEADY_STATE
    ↓ (disconnect)
DISCONNECTED
```

If schema versions disagree at HANDSHAKING, transition to **PASSIVE_WAIT** (see § 2). PASSIVE_WAIT periodically re-handshakes (every 5 minutes) to detect an upgrade on the other side.

### Catch-up phase

When a connection is (re-)established:

1. Each side sends a `CATCHUP_REQUEST` listing `lastSyncedSequence` per principal the requester cares about (filtered by subject subscription).
2. Each side responds with an ordered stream of SyncFrames for each principal, starting from the sequence after the requester's last seen.
3. Streaming continues until the requester's view converges with the sender's latest sequence per principal.
4. Both sides send `CATCHUP_COMPLETE` when they have nothing more to send.
5. When both have sent `CATCHUP_COMPLETE`, the channel moves to STEADY_STATE.

**Concurrent writes during catch-up** are handled by the general SyncFrame flow — any new write on either side during catch-up is broadcast as a normal steady-state frame in parallel. Receivers process frames in order regardless of whether they arrived during catch-up or steady-state.

### Steady state

In STEADY_STATE, every local write to an eligible record (see § 4 for eligibility rules) is immediately broadcast as a SyncFrame to the peer. Replication is sub-second under normal network conditions.

Frames are processed by the receiver in order per `(originatingInstanceId, originatorPrincipalId)` pair. Cross-principal ordering is not preserved (there's no global order; principals are independent).

### Disconnection & write buffering

If the peer disconnects:
- Both sides buffer **outbound** writes locally (no cap — bounded by disk). A buffered write is just a filesystem record awaiting the next successful broadcast.
- **Local reads and writes continue normally.** Federation-down does not mean Flair-down.
- When the connection restores, the CATCHING_UP phase drains the buffer by streaming all post-disconnect writes.

If the disconnection lasts longer than the local Lamport clock can reasonably reconcile (multi-week outage, etc.), there are no automatic conflict-resolution shortcuts — the catch-up phase still streams every missed frame, and the general conflict rules in § 4 apply to each one.

---

## 4. Conflict Resolution

Conflict resolution rules differ by record type. Memory records are mostly append-only with supersede chains; Principal/Credential metadata is small but mutable. Applying LWW uniformly would silently drop Principal updates.

### 4.1 Memory records

- **Appends** (new memories) do not conflict. Both sides accept independently; sync replicates both.
- **Supersedes** are resolved via Lamport clocks: the memory with the highest Lamport value wins the "current" slot. Losing memories remain in the database as history.
- **Wallclock ties** (equal Lamport) resolve deterministically by `(originatorPrincipalId, recordId)` lexicographic comparison.
- **Tombstones** (explicit deletion) propagate the same as upserts, carrying a Lamport clock. A tombstone with a higher Lamport wins over a concurrent upsert.

### 4.2 Principal records

Principal records contain multiple independently-updatable fields (subjects, trustTier, runtime, displayName, etc.). A naive record-level LWW loses field updates when two instances change different fields concurrently.

**Solution:** Field-level LWW. Each field carries its own Lamport clock. The record sync frame encodes the full record but includes per-field Lamport values in metadata:

```json
{
  "recordType": "principal",
  "recordId": "usr_nathan",
  "recordPayload": {
    "id": "usr_nathan",
    "displayName": "Nathan",
    "subjects": ["strategy", "product"],
    "trustTier": "endorsed",
    "runtime": null
  },
  "fieldLamport": {
    "displayName": 3,
    "subjects": 7,
    "trustTier": 2,
    "runtime": 1
  }
}
```

The receiver compares each field's Lamport clock against its local value and merges the higher-clocked field in from the incoming frame. Fields that are equal at the clock level tie-break deterministically.

### 4.3 Principal `subjects` as a set-CRDT

Subjects are a set, and the common mutation pattern is add/remove individual subjects. A field-level LWW on the whole set loses concurrent adds. For `subjects` specifically, the record stores both the current set and a tombstone set:

```json
{
  "subjects": ["strategy", "product", "flair"],
  "subjectsTombstones": ["old-project"],
  "fieldLamport": {
    "subjects_added:strategy": 4,
    "subjects_added:product": 5,
    "subjects_added:flair": 7,
    "subjects_removed:old-project": 6
  }
}
```

Merge logic: for each `subjects_added:X` or `subjects_removed:X` entry, the higher Lamport wins. Net set membership is `added_lamport[X] > removed_lamport[X]`. This is an OR-set with tombstones, a standard CRDT pattern.

### 4.4 Credential records

Credential records (WebAuthn, bearer tokens, Ed25519 device keys) are append-only in practice and rarely need conflict resolution. The edge case is revocation:

- **New credential:** normal SyncFrame, conflict-free.
- **Revocation:** modeled as a tombstone operation that carries the credential id and a Lamport clock. Revocation always wins over any concurrent unrevoke (of which there are none in normal operation, but this is explicit for safety).

### 4.5 Grant records (legacy)

MEMORY-MODEL-V2 deprecates the Grant table for read access but keeps it for audit/multi-org future. Grant records are treated as Principal records for conflict resolution (field-level LWW).

### 4.6 Soul records

Soul data is per-principal metadata — subject interests, preferences, operational config. Treated as Principal records (field-level LWW).

### 4.7 Peer public key propagation (Kern's 2026-04-09 finding)

In the hub-and-spoke topology (§ 1), spokes only pair directly with the hub. They don't peer with each other. But cross-spoke memory records ARE expected to flow: a memory written by `agent_anvil` on the anvil-vm spoke needs to reach rockit via the two-hop path `anvil-vm → hub → rockit`.

When rockit receives a relayed record whose `originatorInstanceId` is `anvil-vm`, rockit needs to verify the signature (§ 6.1) against anvil-vm's instance public key. **But rockit has never paired with anvil-vm directly** — its Peer table only contains the hub. Without anvil-vm's public key in the local Peer table, rockit cannot verify the record and must reject it.

Kern caught this gap during the 2026-04-09 review. The fix is **peer public key propagation from the hub to all spokes.**

**Mechanism:**

- Each time the hub adds, removes, or updates a Peer record, it broadcasts a `PeerAnnouncement` control frame to all currently-connected spokes.
- Spokes receive the announcement, validate it (the frame is signed by the hub's instance key, which spokes have already pinned), and update their own Peer table — but with a special flag: `relay_only: true`.
- `relay_only: true` peers are used ONLY for signature verification on relayed records. Spokes cannot initiate a sync channel with `relay_only` peers. They cannot be used for pairing. They exist in the local Peer table solely to support multi-hop verification.
- On hub reconnect, the hub re-sends the full Peer table snapshot so spokes that were offline catch up on peer changes.

**PeerAnnouncement frame format:**

```typescript
interface PeerAnnouncement {
  type: "control";
  control: "peer_announcement";
  operation: "add" | "remove" | "update";
  peer: {
    instanceId: string;
    publicKey: string;       // base64url
    role: "hub" | "spoke";
    addedAt: string;
  };
  hubSignature: string;      // Ed25519 signature over (operation + peer) by the hub's instance key
}
```

**Trust model:**

The hub is a trusted relay point for its spokes. When rockit joined the federation, it pinned the hub's public key. All PeerAnnouncements are signed by the hub, so rockit can verify them using the already-pinned hub key. This means:

- **The hub can add any "peer" it likes to every spoke's `relay_only` list.** A compromised hub could lie about the existence of a fictional anvil-vm and use that to inject forged records. But since the hub is already trusted for channel authentication and for attesting its own human-record signatures, the additional trust to propagate peer identities doesn't expand the trust surface — compromising the hub already compromised the federation.
- **Spokes cannot cross-verify peer announcements.** If the hub tells rockit "anvil-vm's key is K1" and tells tps-anvil "rockit's key is K2", rockit has no way to independently confirm that the anvil-vm identity is real. This is acceptable because compromising the hub is the higher-order threat.

**Phase 1 scope requirement (Kern's finding):**

This spec previously implied that a spoke could verify a relayed record just because the signature was valid. That's incorrect without peer public key propagation. **Peer public key propagation via PeerAnnouncement frames must be in Phase 1 scope** — without it, cross-spoke records fail verification and multi-hop sync doesn't work.

**Failure mode if not implemented:**

Records from anvil-vm arrive at rockit. rockit looks up `originatorInstanceId` in its Peer table, finds nothing, rejects with `NACK: UNKNOWN_ORIGINATOR`. The record is discarded. Cross-spoke knowledge never propagates. Looks like "sync works between rockit and hub" but "doesn't work between spokes" — which would be a silent data-visibility bug for users.

---

## 5. Frame Format & Wire Protocol

### 5.1 Framing

JSON messages delimited by the WebSocket frame boundary. Each WebSocket text frame is exactly one SyncFrame or one control frame.

### 5.2 Control frames

Not all traffic is SyncFrames. The channel also carries:

- `HANDSHAKE` — initial exchange (§ 2)
- `CATCHUP_REQUEST` — catch-up start
- `CATCHUP_COMPLETE` — catch-up done signal per side
- `HEARTBEAT` — sent every 30 seconds in STEADY_STATE if no other frames flowed; missing heartbeats trigger reconnect
- `ACK` — optional per-frame acknowledgement (see § 5.5)
- `NACK` — rejection with a reason code
- `PEER_ANNOUNCEMENT` — hub-to-spoke broadcast of peer table changes (§ 4.7)

Control frames have `type: "control"` and a `control` field distinguishing them from SyncFrames.

### 5.3 Protocol version byte

Every frame begins with `protocolVersion: 1`. Per Kern: this reserves a binary pivot path for 1.x or 2.0 without breaking existing peers. If we later switch to CBOR or MessagePack for large memory payloads, bumping the version allows new instances to negotiate binary with each other while staying backward-compatible with v1 peers.

For 1.0, JSON is the only supported format. Debuggability during stabilization is worth the bytes.

### 5.4 Sequence ordering guarantees

Within a single `(senderInstanceId, originatorPrincipalId)` pair, frames are delivered in strict sequence order. Out-of-order delivery is a protocol violation that triggers a NACK with reason `OUT_OF_ORDER`.

Across principals, no ordering is guaranteed. An instance may receive `agent_flint` seq 50 before `agent_kern` seq 10, and that's fine — they're independent streams.

### 5.5 Ack semantics

Each SyncFrame is optionally acknowledged by an `ACK` control frame carrying the frame id. ACK is fire-and-forget reliability — the sender uses ACKs to update its local "last confirmed delivered to peer" marker per principal, which is a separate concept from `lastSyncedSequence` (which tracks the reverse direction).

Missing ACKs alone do NOT trigger retransmission. Retransmission happens via the catch-up phase on reconnect. The ACK marker is used to:
- Identify which local buffered writes can be garbage-collected (both sides confirm they've seen them)
- Expose replication lag to operators (`flair sync status` shows per-peer per-principal lag)

### 5.6 Replay protection

Each SyncFrame's `frameId` is a UUID. The receiver maintains a 60-second window of recently seen frame ids per sender; any duplicate in that window is rejected. Outside the window, the sequence number prevents replay — a frame with a sequence number below `lastSyncedSequence` is rejected as `ALREADY_APPLIED`.

---

## 6. Security

### 6.1 Signature-to-Principal Binding (Kern's finding, revised 2026-04-08)

This is the critical new security requirement Kern surfaced during his review. The verification model differs between agent-authored and human-authored records per FLAIR-PRINCIPALS § 1 "Identity vs Credential":

When a receiver processes an incoming SyncFrame, it performs **two independent verifications**:

1. **Channel authentication.** Verify the WSS channel's peer identity via the pinned instance public key (the `senderInstanceId` must match a pinned peer record, and the WSS connection's TLS+challenge-response must be valid).

2. **Record signature verification.** Verify the SyncFrame's `signature` field. The verification key depends on the Principal kind of the `originatorPrincipalId`:

   - **If the originating Principal has `kind: "agent"`:** verify against the agent's registered Ed25519 public key from the local Principal table. The signature is from the agent itself.
   - **If the originating Principal has `kind: "human"`:** verify against the **originating instance's** public key (the instance that first accepted and signed the human's write). The SyncFrame carries `originatorInstanceId` in addition to `originatorPrincipalId`; the receiver looks up that instance's pinned public key in its Peer table. The signature is from the instance, not from the human.

3. If verification fails, the frame is rejected with `NACK: SIGNATURE_MISMATCH`. The rejection is logged.

**Why the split.** Per FLAIR-PRINCIPALS (revised 2026-04-08 per Nathan's direction), humans do not have server-held private keys. Records written by humans are signed at the instance level instead — the Flair instance that accepted the write signs the record with its instance key. Other instances verify that instance signature. The guarantee is "Instance X attests that Human Y wrote this at time T," not "Human Y cryptographically wrote this" directly.

**Blast radius of peer compromise:**

- **Agent records:** a compromised peer can inject records claiming to originate from agents whose private keys it holds. A compromised rockit can forge `agent_flint`, `agent_kern`, etc. memories because rockit holds those agents' keys. A compromised rockit **cannot** forge records from agents originating on the Fabric hub (if any) or on another spoke. The per-agent signature check catches such forgery.
- **Human records:** a compromised peer can inject records claiming to originate from any human, but only with the peer's own instance signature. Receivers see "instance X signed this record claiming Nathan wrote it" — they trust the attestation to the extent they trust the instance. A compromised rockit can forge Nathan-authored records; receivers would accept them because rockit's instance key is pinned. This is a weaker guarantee than per-principal signing would give, and it's the explicit trade-off Nathan accepted in exchange for not storing user private keys on Flair.

**Mitigations for the weaker human-record guarantee:**

- Audit logs: every record stores the originating instance id, visible in `flair memory show`. A forensic reviewer can see which instance attested each record.
- Instance-key compromise detection: unusual write volume or pattern from an instance should alert the operator. This is part of § 9.5 "Compromised peer" response.
- OAuth session hardening: short-lived tokens (max 1 hour), refresh token rotation, client fingerprinting, anomaly detection on sessions. See FLAIR-PRINCIPALS § 2 OAuth.
- WebAuthn for direct sessions: passkeys are phishing-resistant and hardware-bound; a human session can only be hijacked via active session theft (cookie theft, token leakage), not via credential reuse.

### 6.1.1 SyncFrame originatorInstanceId field addition

To support human-record verification, the SyncFrame schema gains one field that wasn't in § 1:

```typescript
interface SyncFrame {
  protocolVersion: 1;
  frameId: string;
  senderInstanceId: string;       // who is relaying this frame NOW
  senderSequence: number;
  originatorPrincipalId: string;  // who the record is attributed to
  originatorInstanceId: string;   // NEW: which instance signed this record originally
                                  //      (for agents, this == the instance that was running
                                  //       when the agent wrote it; for humans, this is the
                                  //       instance that accepted the OAuth/WebAuthn write)
  recordType: "memory" | "principal" | "credential" | "grant" | "soul";
  operation: "upsert" | "tombstone";
  recordId: string;
  recordPayload: unknown;
  lamport: number;
  signature: string;              // Ed25519 sig over the frame
                                  // For agent records: by originatorPrincipalId
                                  // For human records: by originatorInstanceId
}
```

The schema previously listed only `senderInstanceId` (the immediate peer relaying the frame). The new `originatorInstanceId` disambiguates "who relayed this frame right now" from "who first signed this record." In a hub-and-spoke topology, records from agent_kern on anvil-vm are first signed on anvil-vm (originatorInstanceId = anvil-vm), relayed to Fabric (senderInstanceId = anvil-vm → Fabric), then relayed from Fabric to rockit (senderInstanceId = Fabric at the second hop). The originator field is stable across hops; the sender field changes.

### 6.2 Instance key compromise

If an instance's private Ed25519 key is compromised, the attacker can:
- Impersonate the instance to its peer (WSS channel auth)
- Forge SyncFrames originating from Principals whose keys that instance holds

The attacker cannot:
- Forge SyncFrames originating from Principals owned by the other instance
- Decrypt past traffic (TLS 1.3 forward secrecy)
- Bypass replay protection (sequence numbers are not derived from the instance key)

**Recovery from compromise:** `flair peer revoke <peer-id>`. Immediately disconnects the channel, removes the peer from the local table, and refuses reconnections. To re-establish, generate a new bootstrap token and pair again.

### 6.3 Replay & timing attacks

- **Replay:** prevented by sequence numbers and the 60-second frame id window (§ 5.6).
- **Timing/correlation:** TLS protects all payloads; an attacker observing the wire sees only encrypted WSS frames. The peer's IP address is not sensitive (it's the public endpoint). rockit's IP is not exposed inbound because rockit dials out.

### 6.4 Selective sync — what never leaves

The following never crosses the sync channel under any circumstances:

- Memory records with `visibility: "private"`
- Memory records tagged `no-sync`
- The instance's private Ed25519 key (held in each instance's Harper blob, never transmitted)
- OAuth client secrets
- OAuth access/refresh token plaintexts (only hashes / signed JWTs are stored; the plaintexts only exist in transit to the client)
- Bearer token plaintexts (only hashes are stored; hashes are synced, plaintexts never existed post-creation)
- WebAuthn credential private keys (they never leave the authenticator, period)
- WebAuthn credential public keys **are** synced as part of the Credential record
- The `flair.instance_key_passphrase` configuration value

**Per-principal Ed25519 private keys for humans are not listed above because they do not exist** (revised 2026-04-08 per Nathan). Human records are signed by the instance key instead. See § 6.1 and FLAIR-PRINCIPALS § 1.

### 6.5 Subject subscription

Peers can configure selective sync by subject — hosted might subscribe only to subjects relevant to a human user's mobile Claude usage, not to internal team-chatter subjects. Subscription is set per-peer in the Peer record:

```
flair peer update <peer-id> --subject-subscriptions "strategy,product,deployment"
flair peer update <peer-id> --subject-subscriptions "all"   # default
```

The sender evaluates every outbound SyncFrame against the peer's subscription. Frames for subjects the peer hasn't subscribed to are not sent. Catch-up also honors subscription — unsubscribed principals/subjects are not streamed.

---

## 7. Harper Fabric Deployment Specifics

This section describes what Flair does on Harper Fabric. All user-facing deployment operations happen through Flair CLI (see FLAIR-CLI.md); this section covers the mechanics underneath.

### 7.1 Packaging

Flair is packaged as a **Harper Fabric app** — a Harper application component that includes:
- Flair resources (Principal, Memory, Credential, Peer, etc.)
- OAuth 2.1 authorization server endpoints (`/oauth/authorize`, `/oauth/token`, `/oauth/register`, `/.well-known/oauth-authorization-server`)
- Web admin UI routes (from FLAIR-WEB-ADMIN)
- flair-mcp HTTP remote MCP endpoint
- The `/sync` WebSocket endpoint for federation
- The `/pair` HTTP endpoint for one-shot pairing handshakes

The flair package is vendored inside the Flair CLI distribution (see FLAIR-CLI § 1 — option C, bundled Harper Core). When the user runs `flair deploy --target fabric://...`, the CLI reaches into its own package for the flair component and pushes it to Fabric.

### 7.2 Deployment is wrapped by Flair CLI

Users never type `harper deploy` directly. `flair deploy --target fabric://<cluster>` shells out to:

```
harper deploy \
  target=https://<cluster>.harper.fabric \
  username=<from-keychain> \
  password=<from-keychain> \
  project=flair \
  package=<vendored-flair-component-path> \
  restart=true \
  replicated=true
```

Fabric credentials come from the local OS keychain (populated earlier by `flair remote login <cluster>`). The `harper` command's stdout/stderr is captured by Flair CLI; only step-level progress is surfaced to the user. If Harper errors, Flair CLI surfaces the error with context, not the raw Harper output.

Push-based deployment is the 1.0 choice (CLI pushes the vendored component bundle to Fabric). Pull-based deployment (Fabric pulls from a git repo) is possible but introduces a distribution channel we'd have to maintain.

### 7.3 Runtime configuration uses Harper's operations API

Harper exposes `set_configuration` / `get_configuration` as operations-API commands that modify app configuration after deployment, without redeploying. Flair CLI wraps these for every operation that needs to push a value to the hub:

- `flair deploy` uses `set_configuration` to push the instance key passphrase and any initial role settings
- `flair pair add` uses `set_configuration` to push the ephemeral bootstrap token
- `flair sync status` uses `get_configuration` to read per-peer state (if stored in config rather than in Harper data)

Config changes that require a Flair service restart trigger `harper restart_service target=... service=flair` as a follow-up step, automatically. The user does not see either command.

**Key property:** no sensitive runtime value is embedded in the initial `harper deploy` command. Deploy is for the code bundle; `set_configuration` is for the secrets. This is Nathan's guidance literally ("config can be set, not part of deploy"). It means the deploy command itself can be logged, replayed, or placed in CI without leaking secrets — the secrets come later, separately.

### 7.4 Secret storage on Fabric

Harper Fabric does not provide a dedicated secrets manager. Flair's strategy on Fabric:

| Secret | Where it lives on Fabric | How it's protected |
|---|---|---|
| **Instance private Ed25519 key** | Harper blob record `instance:ed25519:private` | Encrypted at rest with a key derived from `flair.instance_key_passphrase` via Argon2id → AEAD. The passphrase itself lives only in the deploying user's local OS keychain and is pushed via `set_configuration` at deploy time. |
| **Instance key passphrase** | `flair.instance_key_passphrase` config | Stored in Harper config. Visible to admins with deploy credentials. The only mitigation is that the passphrase alone doesn't decrypt the key — you also need the blob, which requires DB access. |
| **Bootstrap token** (during pairing) | `flair.pending_bootstrap_token` config, briefly | Stored for ≤15 minutes. Hashed in-place by Flair during its own startup sequence so that only the hash remains after the brief initial window. Cleared after successful pair. |
| **OAuth client credentials** | Principal.credentials column | Client secrets hashed where the protocol permits; refresh tokens stored hashed. |
| **Bearer tokens** | Credential records | Stored as SHA-256 hashes + prefix. Plaintext never persisted post-creation. |
| **OAuth access/refresh tokens** | Issued short-lived JWTs, not stored | Signing key lives in Harper blob with similar protection to the instance key. |
| **WebAuthn public keys** | Credential records | Not secret. Stored plaintext. |
| **WebAuthn private keys** | Never on Flair | Hardware-bound on the authenticator, never leave it. |
| **Per-human-principal Ed25519 private keys** | Never on Flair | Per FLAIR-PRINCIPALS § 1 revision — humans don't have them at all. Records signed by the instance on their behalf. |

**Under no circumstances** does any of the above appear in stdout, Harper logs, the web admin UI debug view, or any exported backup without explicit encryption.

### 7.5 No CLI access on the Fabric-hosted instance

The Fabric-hosted Flair instance runs unattended. There is no shell into the box. Every operation is one of:

- **Harper operations API calls** from a machine with deploy credentials — these are what Flair CLI wraps
- **Sync traffic from paired spokes** — the spokes initiate and drive all inter-instance state flow
- **Web admin UI calls** — browser-based principal and credential management (FLAIR-WEB-ADMIN)
- **Public HTTP endpoints** — OAuth, MCP, WebAuthn, the `/sync` WSS

There is no way to log into the Fabric-hosted Flair and run an arbitrary command. This is a feature, not a limitation — it means the attack surface is precisely the set of HTTP endpoints Flair exposes.

### 7.6 Log surfacing and the "stdout is semi-public" rule

Harper Fabric surfaces the Flair app's stdout/stderr through Harper's log facility (`read_log`, `read_transaction_log`, `read_audit_log`). These logs are accessible to:
- Anyone with Fabric deploy credentials (the developer, i.e., Nathan)
- Fabric platform operators (Harper's ops team for the hosted service)
- Anything that can read Fabric's internal log storage

Therefore:

- **Never log secrets.** Instance keys, passphrases, bootstrap tokens, bearer tokens, OAuth auth codes, OAuth tokens, WebAuthn registration challenges. If you wouldn't email it, don't log it.
- **Log operational state freely.** Connection attempts, peer status, catch-up progress, rate-limit hits, error codes, SLO metrics — all useful, none sensitive.
- **Log public keys and instance ids.** These are public by definition and operators need to see them during bootstrap and debugging.
- **Treat audit events specially.** Principal creation, credential issuance, credential revocation, peer pair, peer revoke — these belong in Flair's own audit log (stored in Harper data with structured retention), not in stdout.

Flair CLI's `flair deploy logs --target fabric://...` wraps `harper read_log` so users can tail the hub's logs without touching Harper commands.

### 7.7 Persistence across Fabric restarts

Harper data persists across restarts (Harper Core behavior, inherited by Fabric). Records that survive:

- All Flair database tables (Principal, Credential, Memory, Peer, Soul, Audit, etc.)
- Harper blobs (including the instance private key blob)
- Harper configuration values

Records that do NOT survive restart:

- In-memory state (open WSS connections, pending ACK windows, in-progress OAuth flows, Lamport clock counters above what's been written to disk — these recompute from persisted data on restart)
- Stdout log history beyond Harper's retention window

### 7.8 TLS certificates

Harper Fabric manages TLS certificates for the hub's public endpoint — either via a Fabric-provided domain (e.g. `<cluster>.harper.fabric`) or Bring Your Own Domain (BYOD) with DNS pointing at the Fabric cluster. Either path gives Flair a valid TLS cert on all its public endpoints (`/sync`, `/pair`, `/oauth/*`, `/mcp`, web admin) automatically.

No Let's Encrypt automation, no certificate renewal logic, no cert file management on our side. This is one of the material wins of using Fabric as the hub.

### 7.9 Blob storage is used extensively

Harper supports blob records as a native feature — arbitrary binary data stored alongside the relational data, persistent across restarts. Flair uses Harper blobs for:

- The instance private key (encrypted)
- The OAuth signing key (encrypted)
- Any memory payloads that exceed comfortable inline storage (rare, but enabled for future)
- Audit log archives older than 30 days (future)

Per Nathan: "Private keys would need to be in harper blobs to be replicated and persisted." The instance key and OAuth signing key follow that guidance directly.

### 7.10 Where Flair CLI knows Fabric-isms live

Most of the Fabric-specific knowledge in Flair CLI is isolated to one module in the Flair CLI codebase (let's call it `cli/src/targets/fabric.ts` — exact path TBD at implementation time) that:

- Knows how to shell out to `harper` with the right environment
- Translates Flair CLI operations into Harper operations API calls
- Captures Harper output and translates error messages into Flair-facing form
- Reads Fabric credentials from the keychain
- Handles Fabric-specific URL patterns (`fabric://<cluster>` → `https://<cluster>.harper.fabric`)

The rest of Flair CLI doesn't know Fabric exists. It calls into a `Target` interface; `fabric.ts` implements that interface for Fabric; a future `local.ts` implements it for local Harper. Adding a new deployment target (Harper Cloud Cluster, self-hosted Harper, a Kubernetes Helm chart, etc.) is a new Target implementation without touching the rest of the CLI.

---

## 8. Selective Sync & Trust Migration

### 8.1 What the hosted instance actually needs

For a 1.0 federated deployment where Nathan uses Claude iOS + web against a Fabric-hosted Flair that syncs with rockit:

- **Nathan's human Principal** — syncs both directions (OAuth-authenticated writes on hosted propagate to rockit; admin operations on rockit propagate to hosted)
- **Memories Nathan writes via Claude** — sync from hosted to rockit so local agents can see them
- **Memories agents write on rockit** — sync from rockit to hosted so Claude on mobile can read them
- **WebAuthn credentials for Nathan** — sync both directions so Nathan can log in on hosted AND manage devices from rockit
- **Soul records** — sync
- **Instance identity, OAuth client secrets, server-held private keys** — NEVER sync (§ 6.4)

### 8.2 Narrow subject subscription for 1.0

If you're worried about exposing too much of the team's internal memory to the hosted instance, narrow the subject subscription:

```bash
flair peer update flair_hosted_h82k --subject-subscriptions "strategy,product,user-context"
```

This limits hosted to only getting memories tagged with those subjects. Memories about Harper internals, team coordination, or ops minutiae stay rockit-only and don't appear in Nathan's mobile bootstrap.

### 8.3 Never migrate trust tier across the sync

A memory record carries its own Lamport clock and signature. The trust-tier assessment (endorsed / corroborated / unverified) is computed locally by each instance based on that instance's view of consensus and endorsement. **Trust tier is not a property on the record; it's a computed view over the record.** A sync does not carry trust tier. Each instance independently decides whether a given memory is corroborated based on its local graph.

This means a freshly-paired hosted instance with no prior memories will initially see every incoming memory as `unverified` until distillation runs and corroboration emerges. This is correct — the hosted instance should not inherit trust from the rockit instance just because rockit said so. Trust is earned locally.

---

## 9. Failure Modes & Recovery

### 9.1 Peer goes down

- Local operations continue unaffected
- Local writes buffer for replication
- Reconnect attempts with exponential backoff
- On reconnect, catch-up drains the buffer
- No operator action required

### 9.2 Peer schema version mismatch

- Sync pauses (PASSIVE_WAIT)
- Both sides log clearly which version they're on
- Periodic re-handshake detects upgrade
- **Operator action:** upgrade the older instance

### 9.3 Peer key rotation

An instance key can be rotated via `flair instance rotate-key`. Rotation invalidates any active peer connections — each peer must be re-paired via a fresh bootstrap token. This is a rare, disruptive operation; it exists primarily for compromise recovery.

### 9.4 Split-brain after long disconnection

Two instances that have been disconnected for weeks will have independently written memories, updated Principal metadata, created Credentials, etc. On reconnect:

- Memory records: both sides merge via Lamport-clock supersede rules. Conflicts resolve deterministically. No data loss (history preserved).
- Principal records: field-level LWW merges field-by-field. Concurrent updates to different fields both survive. Concurrent updates to the same field go by Lamport.
- Subjects set: CRDT merge preserves all adds and removes.
- Credentials: both sides' new credentials are kept; revocations propagate as tombstones.

**Split-brain is not a failure mode.** It's an expected condition that the protocol handles. The recovery is "wait for reconnect, let catch-up run, done."

### 9.5 Compromised peer

- `flair peer revoke <peer-id>` immediately drops the connection and removes the peer
- Records already received from the compromised peer remain in the local database — they cannot be un-received
- Operator can use the audit log to identify which records came from the compromised peer and manually tombstone any that are suspect
- A new peer can be established via fresh pairing

### 9.6 Lost instance private key

If the instance key is lost (disk failure, wipe without backup), the instance cannot authenticate to its peer anymore. The peer will reject the reconnect. Recovery:

1. The affected side generates a new instance identity (cold-start path)
2. The other side's operator revokes the old peer and pairs with the new instance identity via fresh bootstrap token
3. Catch-up replays all state from the surviving side

This is why both sides of a federated pair should have encrypted backups of their instance keys. Rockit backs up to Nathan's offline storage; Fabric's secret store is Fabric's responsibility.

### 9.7 Bootstrap token leaked

The token is single-use and has a 15-minute TTL. If leaked and used by an attacker before the legitimate operator uses it, the attacker pairs first. The legitimate operator detects the failure (`flair peer add` returns "token already consumed") and responds:

- Immediately generate a new instance identity on the target side (destroys the attacker's pairing)
- Issue a new bootstrap token via a fresh boot or admin UI
- Complete pairing before the attacker can again
- Investigate how the token leaked and close the channel

**For 1.0:** accept that a leaked bootstrap token is a real but operator-visible failure. Mitigations are procedural (don't paste the token anywhere except the pairing command). A future hardening could require an out-of-band confirmation (e.g., comparing instance public keys visually), but not for 1.0.

---

## 10. Open Questions

1. ~~Harper Fabric deployment mechanics.~~ **RESOLVED** — `harper deploy` CLI with push-based deployment from Nathan's machine. See § 7.1.

2. ~~Fabric persistent storage.~~ **RESOLVED** — Harper data (including blobs) persists across restarts. Instance private key lives in a Harper blob. See § 7.6, § 7.8.

3. ~~Fabric secret injection.~~ **RESOLVED** — no dedicated secrets manager on Fabric. Secrets are held either (a) as short-lived `harper set_configuration` values for things like the bootstrap token, (b) in Harper blobs encrypted with a key derived from a passphrase configured at deploy time, or (c) hashed in Harper data (bearer tokens, OAuth credentials). See § 7.3.

4. ~~Fabric log surfacing.~~ **RESOLVED — different answer than expected.** Stdout IS visible to Fabric operators, which Nathan flagged as a security concern. We therefore do NOT log the bootstrap token to stdout. Instead, the bootstrap token is pushed to Fabric as a transient `harper set_configuration` value from Nathan's machine. See § 2 pairing flow.

5. **Catch-up performance at scale.** If a fresh spoke pairs with the hub after months of hub writes, catch-up may stream hundreds of thousands of frames. Is there a cap on frames per second during catch-up? Proposed: bound by WSS connection throughput; no artificial cap. Monitor and add one if needed. **Still open.**

6. **Network partition longer than sequence number reset.** If an instance is offline for months and the peer has been actively issuing sequences the whole time, is there any upper bound on the catch-up stream? No — per-principal sequences can be arbitrarily large. Disk is the only bound. **Still open as observation, no action needed.**

7. **Concurrent writes to the same memory's supersede chain from two instances.** Resolved by Lamport clock, but worth confirming that the supersede UI (eventually — `flair memory correct`) handles seeing "this memory has been superseded on the other instance" correctly. **Still open, defer to implementation.**

8. **Enforcement of hub-and-spoke topology in code.** Schema supports any peer relationship; sync logic now expects hub-and-spoke (one central hub, N spokes that only peer with the hub). Proposed: runtime config validator rejects invalid peer configurations at startup. If role is `spoke`, the Peer table must have exactly one entry (the hub). If role is `hub`, peers may be any number of spokes. **Resolved by design, enforce in implementation.**

9. **OAuth token ↔ record write audit correlation.** A human-written record should be traceable back to the specific OAuth session that created it, for forensic purposes when instance signatures are the only provenance. Proposed: each human-written record includes a `authSessionId` in metadata referencing the OAuth session (but NOT the bearer token itself). Sessions are stored in Harper data with creation time, client fingerprint, expiry, and correlation is read-only from the audit view. **New question — worth Sherlock's input in his FEDERATION review.**

10. **Instance key passphrase rotation.** The passphrase that decrypts the instance private key blob is set at deploy time via `harper set_configuration flair.instance_key_passphrase`. Rotating it requires re-encrypting the blob. How often should rotation be required? Proposed: no forced rotation. Operator-initiated rotation via `flair instance rotate-passphrase`, which re-encrypts the blob and updates the config value in one transaction. **Defer to implementation.**

---

## 11. Implementation Phasing

**Phase 1 — Schema + instance identity**
- Add InstanceIdentity and Peer tables
- Generate instance key on first boot
- `flair peer add` / `flair peer list` / `flair peer revoke` CLI
- Bootstrap token generation (not yet surfaced via web UI)
- **Peer public key propagation (§ 4.7).** Hub broadcasts PeerAnnouncement frames to all spokes on peer table changes. Spokes maintain a `relay_only: true` Peer table entry for every other instance in the federation. Required for multi-hop verification to work at all — without it, cross-spoke records fail verification silently. (Kern's 2026-04-09 finding.)

**Phase 2 — WebSocket sync channel**
- `/sync` endpoint on hosted side
- rockit outbound client
- Handshake with schema version check
- Automatic reconnect logic
- HEARTBEAT, ACK, NACK control frames

**Phase 3 — SyncFrame flow**
- Local write → SyncFrame emission
- Incoming SyncFrame → validation → apply
- Signature-to-Principal binding (§ 6.1)
- Per-principal sequence tracking

**Phase 4 — Catch-up phase**
- CATCHUP_REQUEST / CATCHUP_COMPLETE control frames
- Historical frame streaming in sequence order
- Buffer drain on reconnect

**Phase 5 — Conflict resolution**
- Lamport clock integration into memory writes
- Field-level LWW on Principal records
- Set-CRDT on Principal.subjects
- Tombstone propagation

**Phase 6 — Selective sync**
- Subject subscription in Peer record
- Outbound frame filtering by subscription
- Catch-up filtering

**Phase 7 — Harper Fabric deployment**
- Validate deployment mechanism
- Deploy a test hosted instance
- End-to-end pair-and-sync with rockit
- Document the runbook

Phases 1-6 are local dev work. Phase 7 requires Fabric access and real-world validation. Each phase is independently shippable in the sense that it's non-breaking and leaves Flair in a working state (just with less federation capability the earlier you stop).

---

## 12. Things Nathan Would Hate If We Built Them This Way

1. **Polling instead of persistent WSS.** Sync must be event-driven. Polling is a tell that we didn't commit to the design.
2. **Sync-by-log-shipping.** Shipping the Harper commit log across the wire is tempting and wrong — it leaks private memories, ignores subject filtering, and couples us to Harper's internals.
3. **Auto-paired peers.** Federation must be explicit. No auto-discovery, no DCR-equivalent for instance pairing. Every peer relationship requires a human action via bootstrap token.
4. **Silently dropping records on conflict.** Losing memories to LWW without telling anyone is a correctness failure. The history must be preserved, the losing record still exists, and the user must be able to see what happened if they look.
5. **Requiring a tunnel on the rockit ↔ hosted sync link.** Tailscale, Cloudflare Tunnel, WireGuard, reverse SSH — none of these for the sync channel specifically. Single WSS connection over TLS, dialed by rockit, is the only transport for peer sync. (This does not apply to other network paths in the broader Flair deployment — for example, VM-based agents connecting to rockit's Flair as clients may legitimately use tunnels, and that's orthogonal to the sync channel constraint.)
6. **Cross-version sync.** If schemas disagree, stop. Do not try to be clever. Clever is how you corrupt data.
7. **"Eventually consistent after an hour."** Federation should converge within seconds of the writes happening on both sides, not an hour. Anything else is a visible performance bug.
8. **Hardcoding credentials in config.** Instance keys, OAuth secrets, bootstrap tokens — none of these should ever appear in a config file someone might accidentally commit.
9. **Assuming the peer is trustworthy because it paired successfully.** Pairing establishes channel auth; it does not establish content trust. Every record must still be verified against the claimed originator's signature.
10. **Losing the supersede chain across federation.** The chain is the history. Dropping it because of a merge conflict is throwing away the lesson in "we used to think X."

---

## 13. Out of Scope for 1.0

- **N-way federation (N > 2).** Schema supports it; sync logic assumes N=2. Real N-way adds conflict-resolution complexity we don't need yet.
- **Real-time UI notifications of sync events.** The web admin UI will show sync status (§ FLAIR-WEB-ADMIN), but pushing "a new memory synced from rockit" as a toast is out of scope.
- **Bandwidth optimization via binary framing.** Reserved in `protocolVersion` for 1.x.
- **Differential sync of large records.** For 1.0, whole-record replication. Large-memory chunking is a 2.0 concern.
- **Per-field Lamport on every record type.** Memory records use record-level Lamport; Principal records use field-level Lamport. We don't generalize to all record types unless a specific type needs it.
- **Federation across multiple Flair organizations.** A Flair instance serves one logical organization. Multi-tenant federation is a separate architecture.

---

## 14. References

- FLAIR-PRINCIPALS (this repo, specs/) — Principal schema, Signature-to-Principal binding at ingest
- MEMORY-MODEL-V2 (this repo, specs/) — trust tiers, supersede chains
- FLAIR-WEB-ADMIN (this repo, specs/) — admin UI for peer management
- Kern's architecture review, 2026-04-08, Flair memory id flint-<tbd> — specific feedback incorporated in this draft
- Lamport, "Time, Clocks, and the Ordering of Events in a Distributed System" (1978)
- Shapiro et al., "Conflict-free Replicated Data Types" (2011) — OR-set pattern for Principal.subjects
