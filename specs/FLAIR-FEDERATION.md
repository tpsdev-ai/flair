# Flair Federation

## Status
- **Owner:** Flint
- **Priority:** P1 — foundational to 1.0 (standalone hosted topology depends on this being designed correctly)
- **Context:** Design session with Nathan 2026-04-07; Kern architecture review 2026-04-08
- **Reviewers:** Kern (architecture, briefed before draft and incorporated in this version), Sherlock (security — pending review)
- **Composes with:** FLAIR-PRINCIPALS, MEMORY-MODEL-V2, FLAIR-WEB-ADMIN

## Summary

Flair 1.0 must support two deployment topologies as first-class:

1. **Federated** — a local Flair instance (rockit) plus a hosted Flair instance (Harper Fabric), bidirectionally synchronized.
2. **Standalone hosted** — a single Flair instance running on Fabric (or any Harper Core host), complete by itself.

Both run the same Flair codebase. The difference is configuration and whether a peer is declared. This spec defines the federation layer — how two Flair instances establish trust, exchange records, handle conflicts, and stay consistent over an unreliable WAN link — such that the federated topology works and the standalone topology is simply "federation with no peers configured."

Key constraints driving the design:

- **rockit is not publicly reachable.** All peer connections must be initiated outbound from rockit.
- **Tunnels are off the table.** No Tailscale, Cloudflare Tunnel, or SSH-based reverse tunnel. Peer connectivity runs on a single persistent authenticated WebSocket over TLS.
- **Harper Pro replication is unusable.** Source-available license conflicts with our open-source positioning, and replication only exists between Pro nodes anyway. Sync must live at the Flair application layer.
- **The hosted side runs on Harper Fabric with no CLI access.** All operations on the hosted instance must happen via HTTP APIs, bootstrap tokens surfaced through deployment console logs, or sync traffic from a paired peer.
- **"Nathan-grade" reliability.** Every visible failure mode must have a designed recovery path. "Restart it" is not a valid answer.

---

## 1. Concepts

### Instance identity

Each Flair instance has its own **Instance Identity** — an Ed25519 keypair distinct from any agent or human principal. The instance keypair authenticates the instance to its peers; it does **not** sign individual memory records.

```typescript
interface InstanceIdentity {
  id: string;                    // "flair_h82kx9" — generated on first boot
  publicKey: string;             // Ed25519, base64url
  createdAt: string;
  // Private key stored in ~/.flair/data/instance-key (Core) or
  // fabric_secrets.instance_key (Fabric). Encrypted at rest.
}
```

**Why a separate identity:** instance-level auth protects the WSS channel between peers. Per-record signatures (from the originating Principal) protect the integrity of individual memory writes. These are two different trust layers and they must not be conflated — a compromised peer should only be able to inject records for principals it controls, never for principals owned by the other peer.

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

For 1.0, Flair supports at most one peer per instance. The schema is prepared to list more but cross-validation between N>2 peers is out of scope for 1.0.

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

On first boot of a Flair instance (detected by absence of `~/.flair/data/instance-key` or equivalent):

1. Generate an Ed25519 keypair. Store the private key in the encrypted-at-rest secret store. Publish the public key at `/instance-identity.json`.
2. Generate a random instance id (`flair_<12 random base62 chars>`).
3. Log the instance id and public key to stdout so a human operator can see them in the deployment console.
4. Start the HTTP listener, OAuth endpoints, memory resources, and the `/sync` WebSocket endpoint.
5. If Flair is configured as standalone (no peers declared), stop here. The instance is complete.
6. If Flair is configured to expect a peer (federated topology), enter "awaiting pairing" state and log the one-time bootstrap token (see below).

### Pairing a peer — federated topology

The pairing flow differs based on which side has shell/CLI access. rockit has it; Fabric does not.

**Scenario A — rockit + Fabric (the expected 1.0 configuration):**

1. Nathan deploys Flair to Harper Fabric. On first boot, the Fabric instance generates its instance keypair and logs the instance id, public key, and a one-time bootstrap token to stdout. The deployment console surfaces stdout.
2. Nathan reads the bootstrap token from the Fabric console.
3. On rockit: `flair peer add wss://flair.lifestylelab.io/sync --bootstrap-token <token>`
4. rockit's CLI hits the Fabric instance's `/pair` endpoint with the bootstrap token.
5. Fabric verifies the token (single-use, TTL ~15 min, rejected after) and responds with its instance id and public key.
6. rockit pins Fabric's public key in its Peer table.
7. rockit sends its own instance id and public key in the same exchange.
8. Fabric pins rockit's public key in its Peer table.
9. Fabric invalidates the bootstrap token permanently.
10. Both sides now have a mutually pinned peer record. The sync channel opens automatically from rockit to Fabric.

**Scenario B — two instances, both with CLI (rare, mainly for testing):**

Same flow as A, except step 1's token can be retrieved via CLI (`flair bootstrap-token`) instead of deployment console logs.

**Scenario C — standalone hosted only (no peer):**

Pairing is skipped entirely. The instance runs complete by itself. If Nathan later wants to add a local peer, he installs Flair on his machine and runs `flair peer add wss://flair.lifestylelab.io/sync --bootstrap-token <t>` from the new side. Fabric, as the already-provisioned side, issues the bootstrap token via the web admin UI (see FLAIR-WEB-ADMIN).

### Bootstrap token properties

- **Single use.** Consumed and invalidated on first successful pair exchange.
- **Short TTL.** 15 minutes. Expired tokens are rejected.
- **High entropy.** 32 random bytes, base62-encoded.
- **Visible only via deployment console or admin web UI.** Never logged to persistent storage beyond the ephemeral deployment log surfaced to the operator.
- **Single outstanding token per instance.** Generating a new token (via CLI or web UI) invalidates any previous unclaimed one.

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

### 6.1 Signature-to-Principal Binding (Kern's finding)

This is the critical new security requirement Kern surfaced during his review.

When a receiver processes an incoming SyncFrame:

1. Verify the WSS channel's peer identity via pinned public key. (Channel auth.)
2. Verify the SyncFrame's `signature` field against the **originator's** public key as registered in the local Principal table. The signature must be from `originatorPrincipalId`'s Ed25519 public key, NOT from the sending peer's instance key.
3. If the signature does not verify, the frame is rejected with `NACK: SIGNATURE_MISMATCH`. The rejection is logged.

**Why this matters:** without step 2, a compromised peer could fabricate a SyncFrame claiming to originate from `agent_flint` by simply re-signing the frame with its own instance key and dropping the originator signature. Signature-to-Principal binding prevents this — the receiving instance verifies provenance by checking the claim against its own trusted record of who each Principal is (via the Principal table's publicKey field).

**Corollary:** a peer can only inject records originating from Principals whose private keys it actually holds. A compromised rockit can inject memories as any of rockit's local agents (Flint, Kern, Anvil, Pulse, Nathan) because rockit holds those private keys. It cannot inject memories as a Principal that originated on the hosted side. This bounds the blast radius of peer compromise.

**Exception for humans with server-held keys:** for human Principals whose Ed25519 key is held server-side (see FLAIR-PRINCIPALS § 2), the signature is produced by whichever instance wrote the record on the human's behalf. The receiving instance verifies against the registered publicKey for that human Principal. In practice this means a compromised hosted instance could forge records from a human Principal only if that Principal's key was held on hosted. Rockit-originated human writes are still safe because rockit holds the key for humans whose account was claimed from rockit. Humans whose account was claimed from hosted have their key on hosted. This is a deliberate trade-off documented in FLAIR-PRINCIPALS § 9.6.

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
- The instance's private Ed25519 key
- Any principal's private Ed25519 key (server-held)
- OAuth client secrets
- Bearer token plaintexts (only hashes are stored; hashes are synced, plaintexts never existed post-creation)
- WebAuthn credential private keys (they never leave the authenticator, period)
- WebAuthn credential public keys **are** synced as part of the Credential record

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

Harper Fabric deploys Flair as a standard Harper Core application component. The exact deployment mechanism (git-based push, `harper deploy` CLI, container image) needs research before implementation — we haven't dogfooded Fabric yet. This is an open question (see § 10).

### 7.2 Secret storage

The instance private key and any OAuth client secrets must be stored in Fabric's secret store (environment variables injected at runtime, or a secrets manager — needs research). Under no circumstances should these live in the Harper data directory where they might end up in backups or replicas.

### 7.3 No CLI access

All admin operations that would normally be CLI commands become HTTP API calls initiated by the paired rockit peer or by the web admin UI (FLAIR-WEB-ADMIN). The hosted Flair instance runs unattended.

### 7.4 Log surfacing

The bootstrap token and instance identity must be visible in the deployment console's standard log view. Fabric surfaces stdout, so Flair just needs to `console.log` the relevant lines during first boot.

### 7.5 Persistence across Fabric restarts

The instance private key, Peer table, and principal data must persist across Fabric restarts. This requires Fabric-provided persistent storage — the details of how to request persistent volumes on Fabric need verification. Another open question (§ 10).

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

1. **Harper Fabric deployment mechanics.** How does Flair get deployed to Fabric? Git push? Container image? `harper deploy` CLI? Needs verification before we can write the deployment runbook. Probably worth spinning up a test Fabric instance to figure out.

2. **Fabric persistent storage.** Does Fabric provide persistent volumes that survive restarts? How is the instance private key stored across Fabric restarts? Needs verification.

3. **Fabric secret injection.** Is there a Fabric secrets manager we should use for the instance key and OAuth client secrets, or do we roll our own encrypted-at-rest scheme? Needs verification.

4. **Fabric log surfacing.** Can Nathan see stdout during first boot clearly enough to copy the bootstrap token? If not, we need an alternative (e.g., the token appears on the instance's `/bootstrap-info` endpoint for 15 minutes before locking).

5. **Catch-up performance at scale.** If rockit has 100,000 memories and hosted is freshly paired, catch-up may take a while. Is there a cap on frames per second during catch-up? Proposed: bound by the WSS connection throughput; no artificial cap. Monitor and add one if needed.

6. **Network partition longer than sequence number reset.** If an instance is offline for months and the peer has been actively issuing sequences the whole time, is there any upper bound on the catch-up stream? No — per-principal sequences can be arbitrarily large. Disk is the only bound.

7. **Concurrent writes to the same memory's supersede chain from two instances.** Resolved by Lamport clock, but worth confirming that the supersede UI (eventually — `flair memory correct`) handles seeing "this memory has been superseded on the other instance" correctly.

8. **Single-peer-only constraint for 1.0.** Do we need to enforce this in code, or is it convention? I lean code — the Peer table schema supports N but the sync logic assumes 1. Enforcing via code prevents someone accidentally setting up 3 peers and discovering bugs.

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
