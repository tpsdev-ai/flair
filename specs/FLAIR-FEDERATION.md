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

### Instance cold start

On first boot of a Flair instance (detected by absence of the instance Harper blob containing the private key):

1. Generate an Ed25519 keypair.
2. Generate a random instance id (`flair_<12 random base62 chars>`).
3. Look for an **instance key passphrase** in Harper configuration under `flair.instance_key_passphrase`. If present, encrypt the Ed25519 private key with a symmetric key derived from the passphrase (Argon2id → AEAD). If absent, store the private key unencrypted and log a warning — this is acceptable on a trusted host (rockit, Nathan's machines) but a misconfiguration on Fabric.
4. Store the (possibly encrypted) private key in a Harper blob record under the key `instance:ed25519:private`. Store the public key under `instance:ed25519:public` (unencrypted).
5. Store the instance id in Harper configuration at `flair.instance_id` for convenient lookup.
6. Expose the public key via `GET /instance-identity.json` (unauthenticated — the public key is public by definition).
7. **Do not log the instance private key, the passphrase, or any secret to stdout.** Harper Fabric surfaces stdout to platform operators; treat stdout as a semi-public audit trail.
8. Start the HTTP listener, OAuth endpoints, memory resources, and the `/sync` WebSocket endpoint.
9. If Flair is configured standalone (no peer configured), the instance is complete.
10. If Flair is configured as the hub (`flair.role = "hub"`), it accepts inbound `/pair` attempts (see below) but does not initiate connections.
11. If Flair is configured as a spoke (`flair.role = "spoke"` with `flair.hub_endpoint` set), it begins dialing outbound to the hub.

### Pairing flow — hub (Fabric)

The hub doesn't have CLI access, so pairing uses Harper's `set_configuration` API combined with a short-lived `/pair` endpoint:

1. **Nathan deploys Flair to Fabric:**
   ```
   harper deploy target=https://<cluster>.harper.fabric \
     username=<deploy-user> password=<deploy-pass> \
     project=flair package=<flair-package-url-or-path> \
     restart=true
   ```
2. Flair boots on Fabric and enters "awaiting pairing" state. No bootstrap token exists yet.
3. **Nathan generates a bootstrap token locally and sets it on Fabric:**
   ```
   # Generate a 32-byte base62 token locally
   TOKEN=$(flair bootstrap-token-gen)
   # Push it to Fabric as configuration
   harper set_configuration target=https://<cluster>.harper.fabric \
     username=<deploy-user> password=<deploy-pass> \
     flair.pending_bootstrap_token=$TOKEN \
     flair.pending_bootstrap_expires_at=$(date -v+15M -Iseconds)
   ```
   The token is never written to stdout or logs. It exists in the local shell variable on Nathan's machine and in Harper's configuration store on Fabric. When pairing completes or the TTL expires, Flair clears both config keys via `set_configuration` with empty values.
4. **Nathan now pairs rockit to Fabric:**
   ```
   flair peer add wss://<cluster>.harper.fabric/sync \
     --role spoke \
     --bootstrap-token "$TOKEN"
   ```
5. rockit dials the hub's `/pair` endpoint over HTTPS (NOT the WSS sync endpoint yet — pairing is a one-shot HTTP handshake). rockit presents the token and its own instance id + public key.
6. Fabric (hub) validates the token against `flair.pending_bootstrap_token`, checks it hasn't expired, and responds with its own instance id + public key.
7. Both sides pin each other's public keys in their Peer tables.
8. Fabric clears `flair.pending_bootstrap_token` via its internal `set_configuration` call. The token cannot be reused.
9. rockit opens the WSS sync channel at `/sync` using the now-pinned hub identity.

### Pairing flow — spoke (rockit, VMs)

Spokes are initiated from their own CLI. The spoke-side pairing flow:

1. Nathan is on the spoke machine (rockit or a VM)
2. He runs `flair peer add wss://<hub-endpoint>/sync --role spoke --bootstrap-token <token>`
3. The spoke's Flair instance dials the hub's `/pair` endpoint (HTTPS, not WSS) and completes the exchange described above.
4. The spoke records the hub as its single peer in `flair.config.yaml` and the local Peer table.
5. The spoke begins steady-state dial-out to the hub's `/sync` endpoint and catches up.

### Scenario: standalone hosted

For the standalone hosted topology (Fabric only, no spokes), pairing is skipped entirely. The instance runs complete by itself. If Nathan later decides to add a local spoke, he uses the same flow as above — generate a token, `set_configuration` it on Fabric, pair from the new spoke.

### Bootstrap token properties

- **Single use.** Consumed and cleared from Harper configuration on first successful pair exchange.
- **Short TTL.** 15 minutes, enforced via `flair.pending_bootstrap_expires_at` configuration value.
- **High entropy.** 32 random bytes, base62-encoded.
- **Never logged.** Not in stdout, not in Harper audit logs, not persisted beyond the config key Flair clears after use.
- **Client-generated, server-stored.** Nathan generates the token locally on a machine he trusts (rockit, his laptop) and pushes it to Fabric as configuration. This way the token never passes through a "generated by Fabric and retrieved by Nathan" step, which would have required a surface that could leak.
- **Single outstanding token per instance.** Pushing a new token overwrites the previous one.
- **Stored as a hash.** Flair hashes the incoming token on receipt (`set_configuration` value is the plaintext for 15 minutes; Flair immediately re-writes it as a hash via its own internal config call). Pair verification compares incoming candidate tokens against the hash. Means a leaked Harper config snapshot from within the 15-minute window could expose the plaintext, but from outside the window only the hash exists.

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

### 7.1 Deployment story

Flair is packaged as a **Harper Fabric app** — a Harper application component that includes Flair's resources, the openclaw-flair plugin, the OAuth 2.1 server endpoints, and flair-mcp for MCP client access.

Deployment uses Harper's standard CLI:

```
harper deploy \
  target=https://<cluster>.harper.fabric \
  username=$HARPER_DEPLOY_USER \
  password=$HARPER_DEPLOY_PASS \
  project=flair \
  package=<path-or-url-to-flair-package> \
  restart=true \
  replicated=true
```

The `harper deploy` command is the standard Harper CLI operation (aliased to `harper deploy_component`). It supports both push-based deployment (CLI pushes a package) and pull-based deployment (Harper pulls from a git repo). We use push-based for 1.0 to keep deployments explicit and audit-able from Nathan's laptop.

Credentials are passed via environment variables (`CLI_TARGET_USERNAME`, `CLI_TARGET_PASSWORD`) or inline; never committed to source.

### 7.2 Runtime configuration (post-deploy)

Harper exposes `set_configuration` / `get_configuration` operations API commands that modify app configuration **after** deployment. This is how we set sensitive values like the bootstrap token passphrase without baking them into the deploy command:

```
harper set_configuration \
  target=https://<cluster>.harper.fabric \
  username=$HARPER_DEPLOY_USER password=$HARPER_DEPLOY_PASS \
  flair.pending_bootstrap_token=$TOKEN \
  flair.pending_bootstrap_expires_at=$EXPIRES_AT

# Apply config
harper restart_service target=https://... service=flair
```

**Key implication:** the bootstrap token is set via `set_configuration`, not passed through the initial `harper deploy` command. This matches Nathan's guidance: "Config can be set, not part of deploy." Flair reads the config value on startup (or on a config reload) and uses it to authenticate the incoming pair request, then clears it.

### 7.3 Secret storage

Harper Fabric does not provide a dedicated secrets manager. Secrets storage strategies for Flair on Fabric:

- **Bootstrap token** (short-lived): stored transiently in `flair.pending_bootstrap_token` via `set_configuration` for up to 15 minutes, then cleared.
- **Instance private key** (long-lived): stored in a Harper blob record encrypted with a key derived from `flair.instance_key_passphrase` (a configuration value set once during initial deploy via `set_configuration`, never shown in logs). The passphrase is Nathan's responsibility to back up off-box. Losing it means losing the ability to decrypt the instance key and requires re-pairing.
- **OAuth client credentials for DCR-registered clients**: stored in Harper data (Principal table's credentials), hashed where possible, encrypted-at-rest via the instance key passphrase.
- **Per-human-principal private keys**: **not stored on Flair.** See FLAIR-PRINCIPALS for the design that replaces server-held human keys with OAuth-authenticated, instance-signed records.
- **Bearer tokens**: stored as SHA-256 hashes in Harper data (plaintext never persisted after creation).

**Under no circumstances** should any of these secrets be written to stdout. Harper surfaces stdout to Fabric logs, which are accessible to platform operators — Nathan flagged this as a security concern.

### 7.4 No CLI access (to the Fabric-hosted instance)

The Fabric-hosted Flair instance runs unattended. All operations that would normally be CLI-initiated happen through:

- **Harper's operations API** (via `harper <command> target=...` from a machine with deploy credentials) for instance-level config
- **Paired spokes** (rockit, VMs) initiating sync traffic and mail flow
- **The web admin UI** (FLAIR-WEB-ADMIN) for principal and credential management

### 7.5 Log surfacing

Harper Fabric surfaces the Flair app's stdout/stderr through Harper's log facility (`read_log`, `read_transaction_log`). Operators can read logs via Harper's operations API.

**Security implication:** anything Flair writes to stdout is visible to Fabric platform operators and any admin with deploy credentials. Therefore:

- **Never log secrets** — instance private keys, bootstrap tokens, bearer tokens, OAuth codes, passphrases, WebAuthn registration challenges.
- **Log diagnostic state only** — connection attempts, peer status, sync catch-up progress, error conditions, SLO metrics.
- **Log the public key and instance id** — these are public by definition, and operators need to see them during bootstrap and debugging.

### 7.6 Persistence across Fabric restarts

Harper data persists across restarts (Harper Core behavior, inherited by Fabric). Records that survive:

- All Flair database tables (Principal, Credential, Memory, Peer, Soul, etc.)
- Harper blobs (including the instance private key blob)
- Harper configuration values

Records that do NOT survive:

- In-memory state (open WSS connections, pending ACK windows, Lamport clock counters above what's been written to disk — these recompute from persisted data on restart)
- Stdout log history beyond Harper's retention window

### 7.7 TLS certificates

Harper Fabric manages TLS certificates for the instance's public endpoint — either via a Fabric-provided domain (e.g. `<cluster>.harper.fabric`) or Bring Your Own Domain (BYOD) with DNS pointing at the Fabric cluster. Either path gives Flair a valid TLS cert on the `/sync` WebSocket endpoint automatically. No Let's Encrypt automation or certificate management on our side.

### 7.8 Blob storage

Harper supports blob records as a native feature — arbitrary binary data stored alongside the relational data, persistent across restarts, queryable via the operations API. Flair uses Harper blobs for:

- The instance private key (encrypted)
- Any large memory payloads that exceed comfortable inline storage
- Audit log archives (future)

Per Nathan: "Private keys would need to be in harper blobs to be replicated and persisted." We follow that guidance for the instance private key specifically.

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
