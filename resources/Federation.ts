import { normalizeEmptyEmbedding } from "./memory-embedding-value.js";
import { Resource, databases, server } from "harper";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import nacl from "tweetnacl";
import { allowAdmin } from "./agent-auth.js";
import { configuredAdminAgentIds } from "./agent-admin.js";
import {
  canonicalize,
  signBody,
  verifyBodySignature,
  signBodyFresh,
  verifyBodySignatureFresh,
  generateNonce,
} from "./federation-crypto.js";
import { reconcileState } from "./relay-lib.js";
import {
  decideInstanceAnswer,
  INSTANCE_ROW_PRUNE_REMEDY,
  multipleInstanceRowsMessage,
  type InstanceIdentityRow,
} from "../src/lib/instance-identity-row.js";
import { readAllInstanceRows } from "./instance-identity-rows.js";
import { findOrCreateInstance, storeInstanceSeed } from "./instance-create-lock.js";
import { withDetachedTxnAsync } from "./table-helpers.js";
import { isSkillWrite } from "./skill-write.js";
import { stampEphemeralExpiry } from "./memory-durability.js";
import { isReservedSeedId } from "./seed-reservation.js";
import { AGENT_ID_ERROR, isValidAgentId } from "../src/lib/agent-id-rule.js";
import { endsWithContentSelectorSuffix } from "../src/lib/memory-id-policy.js";
import { stripInboundMemoryRow, stripServerStampedFields } from "./memory-declared-attributes.js";
import { noteWriteStamp } from "./embedding-space-guard.js";
import { initFederationCleanup } from "./federation-cleanup.js";
import { verifyFederationRequestBody } from "./replay-store.js";
import { CommittedRowChanged, confirmCommittedRow, verifyCommittedFields, withoutHarperManagedFields, writeBackCommittedRow, WriteBackConflictError } from "./write-back.js";
import { withKeyLock } from "./key-lock.js";
import { withOwnedTransaction } from "./request-transaction.js";
import { txnPausePoint } from "./txn-pause-point.js";
import { writeOutcomeUnknownResponse } from "./memory-write-lock.js";
import { retryRowProblem } from "./federation-retry-lib.js";
import {
  classifyRecord,
  reconstructRecordVerifyBody,
  checkPrincipalEntitlement,
  inboundChangesExistingPrincipalStatus,
  inboundChangesExistingPendingKey,
  agentAdminIdCreateRefusal,
  agentIdentityRefusal,
  keepReceiverAgentAuthority,
  type FederationSyncTable,
  type SkipReason,
} from "./federation-classify.js";
import {
  mergePresenceReceipt,
  presenceHomeBindingReason,
  presenceReceiveEnabled,
  validatePresenceReceipt,
} from "./presence-receipt.js";
export {
  classifyRecord,
  reconstructRecordVerifyBody,
  checkPrincipalEntitlement,
  inboundChangesExistingPrincipalStatus,
  inboundChangesExistingPendingKey,
  recordSignatureVersion,
  PRINCIPAL_OWNING_TABLES,
  FEDERATION_TABLE_POLICY,
  FEDERATION_SYNC_TABLES,
  SKIP_REASON_CLASS,
  SKIP_REASONS,
  RETRYABLE_SKIP_REASONS,
  isSkipReason,
} from "./federation-classify.js";
export type {
  SkipReason,
  RetryableSkipReason,
  ClassifyResult,
  FederationSyncTable,
} from "./federation-classify.js";

// Federation anti-replay: FederationPair and FederationSync both verify through
// verifyFederationRequestBody (resources/replay-store.ts), which claims each
// body nonce ONCE in the instance-wide `ReplayNonce` table after the signature
// has verified (flair#2061). Nonces are globally unique (signBodyFresh generates
// a 128-bit random nonce per request), so the nonce alone is the key.

/** The response for a body whose signature, freshness or nonce check refused. */
function federationVerifyRefusal(reason: string | undefined): Response {
  if (reason === "replay_store_unavailable") {
    return new Response(
      JSON.stringify({
        error: "replay_store_unavailable",
        detail: "This instance cannot record request nonces right now, so it refuses signed federation requests. The server log names the cause.",
      }),
      { status: 503, headers: { "content-type": "application/json" } },
    );
  }
  return new Response(JSON.stringify({ error: `invalid signature — ${reason}` }), {
    status: 401, headers: { "content-type": "application/json" },
  });
}

// Re-export for consumers that import from Federation.ts
export { canonicalize, signBody, verifyBodySignature, signBodyFresh, verifyBodySignatureFresh, generateNonce };

/**
 * Federation resource — hub-and-spoke sync for Flair instances.
 *
 * Implements:
 * - Instance identity management
 * - Peer pairing (one-shot HTTP handshake)
 * - Sync record batches over HTTP push (POST /FederationSync)
 * - Conflict resolution (record-level LWW using updatedAt)
 * - Per-record signature verification using locally pinned originator keys
 *
 * Pairing exchanges and pins both participants' public keys. Cross-peer
 * public-key broadcasts are not implemented; PeerAnnouncement and SyncFrame
 * are unused protocol declarations.
 * Per-record signature enforcement defaults to verify-if-present; requiring
 * signatures is an operator opt-in via
 * FLAIR_FEDERATION_REQUIRE_RECORD_SIGNATURES=true.
 */

// ─── Sync frame types ────────────────────────────────────────────────────────

interface SyncFrame {
  type: "sync" | "ack" | "peer-announce" | "heartbeat";
  instanceId: string;
  timestamp: string;
  lamportClock: number;
  records?: SyncRecord[];
  peers?: PeerAnnouncement[];
}

interface SyncRecord {
  table: string;             // "Memory" | "Soul" | "Relationship" | "Agent"
  id: string;
  data: Record<string, any>;
  updatedAt: string;         // ISO timestamp — LWW tiebreaker
  originatorInstanceId: string;
  signature?: string;        // Ed25519 signature for agent-originated records
  principalId?: string;      // who authored this record (signed at v:2)
  v?: number;                // signature-body version; absent on today's wire
}

interface PeerAnnouncement {
  instanceId: string;
  publicKey: string;
  role: string;
  endpoint?: string;
}

// ─── Per-record signature enforcement mode (federation-edge-hardening slice 3b) ──

/**
 * Whether FederationSync.post requires EVERY record to carry a valid
 * per-record signature (§3a), skipping unsigned ones (`missing_signature`),
 * vs. the default "verify-if-present" mode where an unsigned record still
 * merges (relying on the batch-level signature already verified above it).
 *
 * Default OFF (verify-if-present) — pre-3a spokes don't sign individual
 * records yet, and their batch is already authenticated. Turning this ON
 * is an OPERATOR decision, never auto-flipped by this code: flip it only
 * once every paired peer has been confirmed sending per-record signatures
 * (e.g. by checking SyncLog for unsigned records / peer versions). Flipping
 * it before every peer has upgraded silently starts dropping that peer's
 * records instead of merging them.
 */
function requireRecordSignatures(): boolean {
  return (process.env.FLAIR_FEDERATION_REQUIRE_RECORD_SIGNATURES ?? "").toLowerCase() === "true";
}

/**
 * Phase 3 of flair#1416 — skip leftover v:1 records on principal-owning
 * tables that lack principalId. Default OFF. Flip only once every paired
 * peer is emitting v:2 (check SyncLog for unsigned / v:1 Memory). Same
 * operator-decision pattern as requireRecordSignatures() — never
 * auto-flipped. v:2 Memory is already mandatory-principal regardless of
 * this flag (see checkPrincipalEntitlement).
 */
function requireRecordPrincipal(): boolean {
  return (process.env.FLAIR_FEDERATION_REQUIRE_RECORD_PRINCIPAL ?? "").toLowerCase() === "true";
}

// ─── Conflict resolution ─────────────────────────────────────────────────────

/**
 * The row written is `record.data`, but the row checked (and merged against) is
 * `record.id`. The payload must carry that same id, or the record is not applied.
 */
export function payloadIdMismatch(record: { id: string; data?: Record<string, any> | null }): boolean {
  return !record.data || record.data.id !== record.id;
}

/**
 * Record-level Last-Write-Wins merge.
 * Incoming fields are applied when the remote record's updatedAt is later.
 * Records with no local counterpart are accepted directly.
 */
export function mergeRecord(local: Record<string, any> | null, remote: SyncRecord): Record<string, any> {
  if (!local) return remote.data;

  const merged = { ...local };
  const localUpdated = local.updatedAt ?? "";
  const remoteUpdated = remote.updatedAt ?? "";

  // Simple LWW at record level for 1.0
  // Field-level LWW is the spec target but record-level is sufficient
  // for the initial implementation and avoids per-field clock tracking.
  if (remoteUpdated > localUpdated) {
    // Preserve stored visibility on updates before applying write policy.
    const incoming = { ...remote.data };
    if (incoming.visibility === null || incoming.visibility === undefined) delete incoming.visibility;
    Object.assign(merged, incoming);
    merged.updatedAt = remoteUpdated;
  }

  return merged;
}

/**
 * embedding-space-guard slice 1 (the raw-writer-coverage hole K&S found in
 * review #1554): the sync-in merge persists Memory rows via the RAW table
 * handle, bypassing Memory.post()/put(). An LWW remote-win copies the REMOTE
 * `embeddingModel` into `mergedData`, so a memory synced from a spoke on a
 * different engine/model lands a FOREIGN-space vector. Without tripping the
 * vector-space guard's latch, the next recall's O(1) "uniform" consult would
 * cosine that foreign vector = mixed-space garbage — exactly the failure the
 * guard exists to kill. Trip the latch here.
 *
 * Kept as a note-ONLY helper — the
 * merge's row write stays INLINE at the call site (every synced table's merge
 * through the shared write-back helper, write-back.ts, flair#2441/flair#2450),
 * so the raw-writer coverage gates
 * (authority-field-guard.test.ts / memory-embedding-writer-coverage.test.ts)
 * still enumerate the writer — while the trip decision itself is
 * unit-testable without standing up the full signed sync-in path (see
 * test/unit-isolated/embedding-space-guard-federation.test.ts).
 */
export function noteFederationMergedMemory(
  recordTable: string,
  mergedData: { embeddingModel?: unknown },
  previous?: { embedding?: unknown; embeddingModel?: unknown } | null,
): void {
  if (recordTable === "Memory") {
    noteWriteStamp(mergedData.embeddingModel as string | null | undefined, previous);
  }
}

// ─── Instance identity ───────────────────────────────────────────────────────

/**
 * Every `flair.Instance` row on this instance, or a THROWN error — the ONE
 * strict reader (resources/instance-identity-rows.ts), re-exported here so
 * existing consumers keep importing it from the Federation resource.
 *
 * The readers used to take the first row `search()` yielded. `search()` order is
 * not a fact about an identity: on a table with two rows one reader reported one
 * identity and a pairing peer was handed the other, and which was which depended
 * on the table's internal ordering (flair#1883 round 3).
 *
 * A read that FAILS must not look like a table with no rows: the callers answer
 * 5xx and write nothing, because only a SUCCESSFUL read of zero rows may mint an
 * identity.
 *
 * And neither must a row the reader cannot NAME (flair#1883 round 4): an entry
 * without a usable id used to be skipped here, so a table serving one bad entry
 * (or a good one beside it) read as "the rows I could name" — possibly zero — and
 * the GET's create branch could mint a second identity from a read that never
 * saw the table. `readableInstanceRows` throws instead, which the callers map to
 * 5xx and no write.
 */
export { readAllInstanceRows };

/**
 * GET /FederationInstance — return this instance's identity.
 *
 * The admin UI and CLI tooling read it. Peers do NOT read it while pairing: a
 * spoke is handed this instance's identity in the `POST /FederationPair`
 * response, which FederationPair.post() builds server-side by reading the
 * Instance table directly. (The pair CLI must not GET this path to fill a missing
 * pair publicKey either — flair#822: allowRead is allowAdmin, and get() creates an
 * identity when it finds none, which would invent a hub row; #839.)
 *
 * allowRead()=allowAdmin (defense-in-depth, authorizeLocal-escalation-class
 * follow-up to #601/#604/#609/#612 — flair#614's backstop found this one had
 * NO allow* at all, so Harper's own default — `user?.role.permission.
 * super_user`, satisfiable only by a genuine admin OR authorizeLocal's forged
 * loopback super_user — was silently standing in).
 *
 * With SEVERAL rows there is no single identity to report, so this answers 409
 * naming every row and the prune. It never reports the row the search happened
 * to yield first (flair#1883 round 3).
 */
export class FederationInstance extends Resource {
  async allowRead(): Promise<boolean> {
    return allowAdmin((this as any).getContext?.());
  }

  async get() {
    // Find or create instance identity.
    //
    // A read that did not happen is an ERROR, never "no row" (flair#1883 round 2).
    // This used to log and fall through to the create branch: on a persistent
    // storage or permission failure the GET then MINTED A SECOND identity row on
    // every call, and which identity this instance reported depended on which row
    // `search()` yielded first. Only a SUCCESSFUL read that returns zero rows may
    // create.
    // Every row, not the first one (flair#1883 round 3): with several rows the
    // first is a coin toss, and reporting one identity here while a peer is
    // handed another is how the two writers disagreed in the first place.
    let rows: InstanceIdentityRow[] | null = null;
    let readError: any = null;
    try {
      rows = await readAllInstanceRows();
    } catch (err: any) {
      readError = err;
    }

    if (readError) {
      // 5xx: the caller retries, and a retry that finally reads is the only thing
      // that creates. flair#1233's warn stays — the error class belongs in the
      // server log — but it is no longer a licence to write.
      console.error(
        "[federation] GET /FederationInstance could not read the Instance table — answering 503 and creating NOTHING. " +
          "A read error is not first boot; minting an identity here would add a second row to an instance that already has one. " +
          `${readError?.constructor?.name ?? "Error"}: ${readError?.message ?? readError}`,
      );
      return new Response(
        JSON.stringify({
          error: "instance_identity_unreadable",
          detail: "The Instance table could not be read, so this instance's identity is unknown. Nothing was created.",
        }),
        { status: 503, headers: { "content-type": "application/json" } },
      );
    }

    const decision = decideInstanceAnswer(rows);

    if (decision.kind === "refuse-multiple") {
      // 409: several rows means there is no canonical identity, and reporting
      // one of them would be exactly the coin toss #1883 exists to end — a peer
      // could go on to pin it. Nothing is created and nothing is deleted; the
      // operator resolves the table with the prune this names.
      console.error(
        `[federation] GET /FederationInstance found ${decision.rows.length} Instance rows — answering 409 and creating NOTHING. ` +
          "Which row this instance reports must not depend on which row the search yields first.",
      );
      return new Response(
        JSON.stringify({
          error: "multiple_instance_rows",
          detail: multipleInstanceRowsMessage(decision.rows, "GET /FederationInstance"),
          rows: decision.rows,
        }),
        { status: 409, headers: { "content-type": "application/json" } },
      );
    }

    let instance: any = decision.kind === "answer" ? decision.row : null;

    // Runtime-only signal (flair#1233): whether this instance's private key
    // seed is present in the keystore, i.e. whether it can SIGN (pair/sync).
    // Deliberately NOT persisted — the Instance.status enum is
    // schema-constrained and this is transient machine state; recomputed on
    // every GET.
    let signingKeyAvailable = false;

    if (decision.kind === "none") {
      // First boot: the read OUTSIDE the lock found no row. The create runs in the
      // filesystem bakery critical section (flair#1897) — shared by EVERY HTTP
      // worker of this process AND every process on this Flair home: a read taken
      // UNDER the lock, the mint, the put, the keystore seed and a confirming
      // re-read — so two concurrent first-boot GETs mint ONE row and both are
      // answered with it. A GET that found a row above never reaches here, so
      // reads stay concurrent.
      const outcome = await findOrCreateInstance({
        // Detach the request's transaction for EVERY read inside the lock: the
        // outer read above opened the request's transaction BEFORE this create, so
        // reusing it here would read the pre-create snapshot and mint a second row
        // even serialised (the table-helpers.ts class). A fresh transaction sees
        // the row the prior lock holder committed.
        readAll: () => withDetachedTxnAsync((this as any).getContext?.(), () => readAllInstanceRows()),
        // Commit the WRITE before the lock releases: both the row put and the
        // keystore seed run in a DETACHED transaction, so Harper builds a fresh
        // ImmediateTransaction that commits on its own rather than at the end of
        // the request (the lock cannot serialise a write that commits after the
        // method returns — the earlier BLOCKED finding, flair#1897 slice 1).
        put: (row) => withDetachedTxnAsync((this as any).getContext?.(), () => (databases as any).flair.Instance.put(row)),
        setSeed: (createdId, seed) =>
          withDetachedTxnAsync((this as any).getContext?.(), () => storeInstanceSeed(createdId, seed)),
        seedPresent: async (rowId) => {
          try {
            const { keystore } = await import("../src/keystore.js");
            return keystore.getPrivateKeySeed(rowId) !== null;
          } catch {
            return false;
          }
        },
        mint: () => {
          const kp = nacl.sign.keyPair();
          return {
            id: `flair_${randomBytes(4).toString("hex")}`,
            publicKey: Buffer.from(kp.publicKey).toString("base64url"),
            secretKey: kp.secretKey,
          };
        },
      });

      if (outcome.kind === "refuse-multiple") {
        if (outcome.putCommitted) {
          // This request's OWN detached put committed a row AND the table holds >1.
          console.error(
            `[federation] GET /FederationInstance: this request committed row ${outcome.mintedId}; the table now holds ` +
              `${outcome.rows.length} rows — hand to ${INSTANCE_ROW_PRUNE_REMEDY}.`,
          );
          return new Response(
            JSON.stringify({
              error: "multiple_instance_rows",
              detail: multipleInstanceRowsMessage(outcome.rows, "GET /FederationInstance"),
              rows: outcome.rows,
            }),
            { status: 409, headers: { "content-type": "application/json" } },
          );
        }
        // Pre-put (the read before or the first in-lock read) — nothing created.
        console.error(
          `[federation] GET /FederationInstance found ${outcome.rows.length} Instance rows under the create lock — answering 409 and creating NOTHING.`,
        );
        return new Response(
          JSON.stringify({
            error: "multiple_instance_rows",
            detail: multipleInstanceRowsMessage(outcome.rows, "GET /FederationInstance"),
            rows: outcome.rows,
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        );
      }
      if (outcome.kind === "refuse-unobservable") {
        console.error(
          `[federation] GET /FederationInstance: minted ${outcome.mintedId} but the confirming re-read saw NO row — ` +
            `the detached write was not observable. Refusing (no retry).`,
        );
        return new Response(
          JSON.stringify({
            error: "instance_identity_unobservable",
            detail:
              `This instance minted ${outcome.mintedId} but could not read it back — the write did not commit where expected. ` +
              `Nothing is answered. Retry; if it persists, inspect the flair.Instance table.`,
          }),
          { status: 503, headers: { "content-type": "application/json" } },
        );
      }
      if (outcome.kind === "refuse-lock") {
        console.error(`[federation] GET /FederationInstance: ${outcome.detail}`);
        return new Response(
          JSON.stringify({ error: "instance_create_lock_unavailable", detail: outcome.detail }),
          { status: 503, headers: { "content-type": "application/json" } },
        );
      }
      if (outcome.warning) console.error(`[federation] ${outcome.warning}`);
      instance = outcome.row;
      signingKeyAvailable = outcome.seeded;
    } else {
      // Existing identity: report whether its signing key is present and
      // decryptable. getPrivateKeySeed is a read-only probe that returns null
      // (never throws) when the key file is missing or unreadable.
      try {
        const { keystore } = await import("../src/keystore.js");
        signingKeyAvailable = keystore.getPrivateKeySeed(instance.id) !== null;
      } catch {
        signingKeyAvailable = false;
      }
    }

    return {
      id: instance.id,
      publicKey: instance.publicKey,
      role: instance.role,
      status: instance.status,
      // Runtime-only — see above; never persisted.
      signingKeyAvailable,
    };
  }
}

// ─── Peer management ─────────────────────────────────────────────────────────

/**
 * POST /FederationPair — one-shot pairing handshake.
 * A spoke sends its instance identity; the hub records it as a peer.
 * A FIRST-time pair requires a one-time pairing token generated by
 * `flair federation token`. An otherwise valid, non-revoked RE-pair of an
 * existing peer (same instance id, and a signed request whose key equals the
 * pinned public key) requires NO token — the protocol requires none for an
 * existing peer — though it validates and consumes a supplied one. A re-pair of
 * a revoked peer is refused.
 *
 * Before writing, a re-pair rechecks the pinned key and status inside its owned
 * transaction; a supplied token must pass validation before that Peer re-read.
 * A key that differs is refused (409); otherwise a revoked
 * row is refused (403 peer_revoked). Either refusal writes no Peer row and
 * consumes no token. A row deleted before that re-read is no longer an existing
 * peer: with a valid token the request is paired as a first-time pair with that
 * token; without one it is refused (401, a pairing token is required). On the
 * token path the owned transaction's first read is its token read, so these
 * re-read checks cover a change committed before that read, not after it.
 *
 * A first-time pair (no Peer row at the pre-transaction read) stages its token
 * consume and its Peer write in one owned transaction, then confirms against
 * committed state that the Peer row is still absent before that transaction
 * commits. If that confirm read finds a row for the instance in committed state
 * although the pre-transaction read returned none, the pair is refused (409
 * peer_row_appeared): the transaction aborts, so this request writes no Peer row
 * and the token stays unconsumed. The confirm reports only a row present when it
 * runs, not when that row was committed; it also detects a row committed after
 * the transaction's token read, if that row is still present. Harper has no
 * compare-and-set on a table write, so a row committed after the confirm read
 * and before the commit is not seen by it.
 */
export class FederationPair extends Resource {
  // Pairing is a public endpoint by design — spokes have no Harper credentials
  // on the hub yet. The handler self-validates via PairingToken + Ed25519
  // body-signature. Bypassing Harper's role gate is required because Harper's
  // auth layer (security/auth.js) claims any "Bearer X" header for itself,
  // so we route the token through the body instead.
  allowCreate(_user: any, _record: any, _context: any) {
    return true;
  }

  async post(data: any) {
    const { instanceId, publicKey, role, endpoint, signature, pairingToken } = data || {};

    if (!instanceId || !publicKey) {
      return new Response(JSON.stringify({ error: "instanceId and publicKey required" }), {
        status: 400, headers: { "content-type": "application/json" },
      });
    }

    // Verify request signature against the public key (proves key ownership).
    // Uses fresh verification with anti-replay — even though pair has implicit
    // replay protection via single-use pairingToken, explicit anti-replay is
    // defense-in-depth and keeps signature semantics consistent across endpoints.
    if (!signature) {
      return new Response(JSON.stringify({ error: "signature required — request must be signed" }), {
        status: 401, headers: { "content-type": "application/json" },
      });
    }
    const verifyResult = await verifyFederationRequestBody(data, publicKey);
    if (!verifyResult.ok) return federationVerifyRefusal(verifyResult.reason);

    // ── The identity this response hands the peer, decided BEFORE the pairing
    // token is consumed, BEFORE the peer is read and before ANY peer is written
    // (flair#1883 round 3). ──────────────────────────────────────────────────
    //
    // NOT "before anything": the signature check above has already run and
    // RECORDED ITS NONCE (verifyFederationRequestBody → the ReplayNonce table,
    // see replay-store.ts). That is deliberate anti-replay state, not a
    // pairing effect — but it is written, and the refusal is precise about what
    // it precedes.
    //
    // A spoke PINS what it is handed here as its hub peer, so this value is the
    // identity a pairing outcome depends on. It used to be "the first row of an
    // unordered search", read AFTER the pairing token was consumed and the peer
    // written — so a hub holding two rows could burn a one-time token, record the
    // new peer, and only then answer with whichever row the table yielded first.
    // The read now comes first, and an unreadable table or several rows refuse
    // with the token still unused and NO peer written.
    let identityRows: InstanceIdentityRow[] | null = null;
    try {
      identityRows = await readAllInstanceRows();
    } catch (err: any) {
      console.error(
        "[federation] POST /FederationPair could not read the Instance table — answering 503, consuming NO token and writing NO peer. " +
          `${err?.constructor?.name ?? "Error"}: ${err?.message ?? err}`,
      );
      return new Response(
        JSON.stringify({
          error: "instance_identity_unreadable",
          detail:
            "The Instance table could not be read, so this hub's identity is unknown. Nothing was paired: the pairing token is unconsumed and no peer was written.",
        }),
        { status: 503, headers: { "content-type": "application/json" } },
      );
    }
    const identity = decideInstanceAnswer(identityRows);

    if (identity.kind === "refuse-multiple") {
      // 409: with several rows there is no identity this hub can hand a peer
      // without picking one, and the peer would pin the pick. Refuse before the
      // token is consumed and before any Peer row is written.
      //
      // This route is PUBLIC, and this refusal runs before the pairing token or
      // a re-pairing peer's key is checked: any caller with a self-signed body
      // reaches it. So the answer names no row. Each row's id, role and
      // createdAt go to this hub's log; the caller learns only what it can act
      // on: pairing is blocked on the hub side, and the hub's operator resolves
      // it with the prune, which needs admin credentials.
      console.error(
        `[federation] POST /FederationPair answering 409, consuming NO token and writing NO peer. ` +
          multipleInstanceRowsMessage(identity.rows, "POST /FederationPair"),
      );
      return new Response(
        JSON.stringify({
          error: "multiple_instance_rows",
          detail:
            "This hub has more than one Instance row, so it has no single identity to hand a peer. Nothing was paired: " +
            "the pairing token is unconsumed and no peer was written. The hub's operator must keep one row and delete the rest with: " +
            INSTANCE_ROW_PRUNE_REMEDY,
        }),
        { status: 409, headers: { "content-type": "application/json" } },
      );
    }

    // Check for an existing peer; an otherwise valid, non-revoked re-pair needs no token.
    const existing = await (databases as any).flair.Peer.get(instanceId);
    if (existing) {
      // Re-pairing: verify public key matches (prevents impersonation). Both
      // owned-transaction writes below repeat this comparison on their re-read.
      if (existing.publicKey !== publicKey) return publicKeyMismatchRefusal();
      // A revoked peer does not re-pair (flair#2333): a revoke is a local
      // decision, and a re-pair does not restore it. This runs BEFORE any token
      // is consumed, so this refusal changes neither the Peer row nor a token.
      if (existing.status === "revoked") return peerRevokedRefusal();

      // An otherwise valid, non-revoked re-pair validates and consumes a supplied
      // token as the first-pair path does (flair#2333), under this node's token
      // lock; a consumed token cannot pair a later new peer. Such a re-pair with
      // NO token still proceeds — the protocol requires none (docs/federation.md,
      // "Pairing tokens"). The supplied token is not the request's credential;
      // the request still has to prove key ownership above (`verifyResult`).
      //
      // With a supplied token, the consume AND this peer write run in a FRESH
      // OWNED transaction committed BEFORE the lock releases (withOwnedTransaction).
      // Harper commits the request's own transaction only after this handler
      // returns, so a consume that joined it would still be invisible when the lock
      // frees and a pairing taking the lock right after would read the token
      // unconsumed. The consume and the peer write commit together or neither does:
      // a Peer write that REJECTS inside this transaction callback aborts the owned
      // transaction, so the token is left unconsumed and this re-pair is refused by
      // name (a commit-time error propagates unnamed).
      //
      // Both paths build an existing peer's updated row from their transactional
      // re-read, never from the pre-transaction read above.
      const rePairedRow = (base: any) => ({
        ...base,
        endpoint: endpoint ?? base.endpoint,
        status: "paired",
        updatedAt: new Date().toISOString(),
      });
      const writePeerRow = (owned: any, row: any) => (databases as any).flair.Peer.put(row, owned);

      if (pairingToken) {
        const ctx = (this as any).getContext?.() ?? {};
        // Test-only: inert unless the fault-injection env opt-in is set and armed.
        // Pause AFTER the pre-transaction read of the Peer row and BEFORE the owned
        // transaction, so a competing revoke, key change or delete can commit in
        // between (flair#2333).
        const tokenRepairPause = txnPausePoint("federation-pair-repair-token-pre");
        if (tokenRepairPause) await tokenRepairPause;
        let refusal: Response | undefined;
        let stagedFirstPeer: StagedPairPeer | undefined;
        let stagedPeer: StagedPairPeer | undefined;
        let stagedToken: StagedPairingToken | undefined;
        try {
          refusal = await withPairingTokenClaim(pairingToken, () =>
            withOwnedTransaction(ctx, async (owned) => {
              const claim = await consumePairingToken(pairingToken, instanceId, owned);
              if (claim.kind !== "consumed") return claim;
              stagedToken = claim;
              // The Peer re-read sees a change committed before the owned
              // transaction's first read (its token read); a change committed
              // after that read is not covered by this re-read. A pinned key that
              // differs from the signed request's key is refused 409, a revoked row
              // 403 peer_revoked; throwing aborts the transaction, so the staged
              // consume rolls back and no Peer row is written.
              const current = await (databases as any).flair.Peer.get(instanceId, owned);
              if (current && current.publicKey !== publicKey) throw new PeerKeyChangedDuringRepairError();
              if (current?.status === "revoked") throw new PeerRevokedDuringRepairError();
              // A row deleted before the re-read: this is no longer a re-pair, and
              // the valid token just consumed makes it a first-time pair. Write the
              // row the first-pair path writes, built from the verified request —
              // no field of the deleted row survives.
              if (!current) stagedFirstPeer = { ...firstPairPeerRow(instanceId, publicKey, role, endpoint), pairAttemptWriteId: claim.pairAttemptWriteId };
              try {
                // The marker is this attempt's last-writer id for the field (see
                // StagedPairPeer): a field-level competitor merged in this window
                // can leave it on the committed row alongside its own fields.
                stagedPeer = current ? { ...rePairedRow(current), pairAttemptWriteId: claim.pairAttemptWriteId } : stagedFirstPeer;
                await writePeerRow(owned, stagedPeer);
              } catch (err) {
                // Rethrow so the owned transaction ABORTS: the consume rolls back
                // with the peer write (both commit or neither does). Tagged so the
                // caller answers a named refusal, not a bare 500.
                throw new PeerWriteFailedError(err);
              }
              if (stagedFirstPeer) await confirmFirstPairBeforeCommit(instanceId);
              // Test-only: inert unless the fault-injection env opt-in is set and
              // armed. Holds the existing-Peer re-pair after its Peer write and
              // before the owned transaction commits, so a competing write to
              // the same Peer can commit in between (flair#2691).
              const beforeCommit = txnPausePoint("federation-pair-repair-token-before-commit");
              if (beforeCommit) await beforeCommit;
              return claim;
            }),
          );
        } catch (err) {
          if (err instanceof CommittedRowChanged) return firstPairRowAppearedRefusal();
          if (err instanceof PeerWriteFailedError) {
            const cause: any = err.cause;
            console.error(
              `[federation] POST /FederationPair re-pair: the Peer write failed; the owned transaction aborted, so the pairing token is NOT consumed (unconsumed and retryable while valid). ` +
                `${cause?.constructor?.name ?? "Error"}: ${cause?.message ?? cause}`,
            );
            return peerWriteFailedRefusal();
          }
          if (err instanceof PeerRevokedDuringRepairError) {
            console.error(
              "[federation] POST /FederationPair re-pair: the Peer row was revoked before the owned transaction read it; the owned transaction aborted, so the pairing token is NOT consumed.",
            );
            return peerRevokedRefusal();
          }
          if (err instanceof PeerKeyChangedDuringRepairError) {
            console.error(
              "[federation] POST /FederationPair re-pair: the Peer row's pinned key no longer matches the signed request's key; the owned transaction aborted, so the pairing token is NOT consumed and no peer was written.",
            );
            return publicKeyMismatchRefusal();
          }
          throw err;
        }
        if (refusal) return refusal;
        const commitPause = txnPausePoint("federation-pair-repair-token-commit");
        if (commitPause) await commitPause;
        if (!stagedPeer || !stagedToken) return firstPairCommitUnconfirmedRefusal();
        const unconfirmed = await confirmTokenPairAfterCommit(pairingToken, stagedPeer, stagedToken, !!stagedFirstPeer);
        if (unconfirmed) return unconfirmed;
        if (stagedFirstPeer) await dropPairBootstrapUser(pairingToken, ctx);
      }

      // The NO-token re-pair's peer write: the token path wrote the row inside the
      // owned transaction above, so its consume and write committed together before
      // the lock released. This path spends no token, but the same shape applies: the
      // write runs in a FRESH OWNED transaction (withOwnedTransaction) that RE-READS
      // the Peer row the pre-transaction read above decided on. A row whose pinned
      // key now differs from the signed request's key is refused 409 (the key
      // mismatch above); a row that is now revoked is refused with the token path's
      // 403 peer_revoked; a row that is now gone means this is no longer a re-pair,
      // and with no token it is refused like a first-time pair without one (401, a
      // pairing token is required). None of these writes a row. The pause below
      // still sits BEFORE that owned transaction, so a competing change commits in
      // between (the guard tests).
      const repairPause = txnPausePoint("federation-pair-repair-pre");
      if (repairPause) await repairPause;
      if (!pairingToken) {
        const ctx = (this as any).getContext?.() ?? {};
        let stagedPeer: StagedPairPeer | undefined;
        const refusal = await withOwnedTransaction(ctx, async (owned) => {
          const current = await (databases as any).flair.Peer.get(instanceId, owned);
          if (!current) return pairingTokenRequiredRefusal();
          if (current.publicKey !== publicKey) return publicKeyMismatchRefusal();
          if (current.status === "revoked") return peerRevokedRefusal();
          // Same last-writer marker as the token route (see StagedPairPeer).
          stagedPeer = { ...rePairedRow(current), pairAttemptWriteId: randomUUID() };
          await writePeerRow(owned, stagedPeer);
          // Test-only: inert unless the fault-injection env opt-in is set and
          // armed. Holds the no-token re-pair after its Peer write and before
          // the owned transaction commits, so a competing write to the same
          // Peer can commit in between (flair#2691).
          const beforeCommit = txnPausePoint("federation-pair-repair-before-commit");
          if (beforeCommit) await beforeCommit;
          return undefined;
        });
        if (refusal) return refusal;
        const commitPause = txnPausePoint("federation-pair-repair-commit");
        if (commitPause) await commitPause;
        // The staged row spreads the re-read row, so the compared fields are its
        // application fields: Harper's own timestamps are left out.
        if (!stagedPeer || await verifyCommittedFields((databases as any).flair.Peer, instanceId, stagedPeer, withoutHarperManagedFields(stagedPeer)) !== "shown") return writeOutcomeUnknownResponse();
      }
    } else {
      // New peer — require a valid pairing token in the request body.
      // The handler self-validates because the endpoint is public at the
      // Harper-auth and middleware layers (Bearer is not usable on Harper —
      // its auth layer claims unknown Bearer values and 401s).
      if (!pairingToken) return pairingTokenRequiredRefusal();

      // Consume the token under its per-key lock (flair#2333): the claim is
      // check-then-consume, so two pairings on this node using the same token
      // cannot both commit a successful claim. The lock is this ONE Flair node's
      // PairingToken store lock, so it excludes concurrent pairings on this node; it
      // is not shared across the nodes of a Fabric instance (see the PR body).
      // A contender exhausting lock attempts while the lock is held gets 409;
      // one acquiring it after a successful claim commits sees the consumed
      // token and gets 401.
      //
      // The consume AND the Peer write run in a FRESH OWNED transaction that is
      // COMMITTED before the lock releases (withOwnedTransaction). Harper wraps
      // POST /FederationPair in a REQUEST transaction that commits only after the
      // handler returns, so writes that joined it would still be invisible when
      // the lock frees: a pairing that takes the lock right after release could
      // re-read the token unconsumed and pair a second peer. Detaching the request
      // transaction re-reads the token from committed state and commits the
      // consume and the Peer write while the lock is held.
      const ctx = (this as any).getContext?.() ?? {};
      // Test-only: inert unless the fault-injection env opt-in is set and armed.
      // Pause AFTER the pre-transaction read of the Peer row and BEFORE the owned
      // transaction, so a competing pair or revoke for this instance commits in
      // between (flair#2512).
      const firstPairPause = txnPausePoint("federation-pair-first-pre");
      if (firstPairPause) await firstPairPause;
      let refusal: Response | undefined;
      let stagedFirstPeer: StagedPairPeer | undefined;
      let stagedToken: StagedPairingToken | undefined;
      try {
        refusal = await withPairingTokenClaim(pairingToken, () =>
          withOwnedTransaction(ctx, async (owned) => {
            const claim = await consumePairingToken(pairingToken, instanceId, owned);
            if (claim.kind !== "consumed") return claim;
            stagedToken = claim;
            stagedFirstPeer = { ...firstPairPeerRow(instanceId, publicKey, role, endpoint), pairAttemptWriteId: claim.pairAttemptWriteId };
            await (databases as any).flair.Peer.put(stagedFirstPeer, owned);
            await confirmFirstPairBeforeCommit(instanceId);
            return claim;
          }),
        );
      } catch (err) {
        if (err instanceof CommittedRowChanged) return firstPairRowAppearedRefusal();
        throw err;
      }
      if (refusal) return refusal;
      if (!stagedFirstPeer || !stagedToken) return firstPairReadBackUnconfirmedRefusal();
      const unconfirmed = await confirmTokenPairAfterCommit(pairingToken, stagedFirstPeer, stagedToken);
      if (unconfirmed) return unconfirmed;

      // Test-only: inert unless the fault-injection env opt-in is set and armed.
      // Pause AFTER the token lock released (and the consume is committed) but
      // BEFORE this request's own transaction commits (Harper commits it when the
      // handler returns). A pairing that takes the now-free lock here must read
      // the token consumed; a request-transaction write would not (flair#2333).
      const claimed = txnPausePoint("federation-pair-claim-done");
      if (claimed) await claimed;

      await dropPairBootstrapUser(pairingToken, ctx);
    }

    // Return our own identity for the peer to record — `{ id, publicKey, role }`,
    // decided BEFORE the token was consumed (above; flair#1883 round 3). An
    // `instance` of `null` means a SUCCESSFUL read found no FederationInstance:
    // that is #839, not a pair-response-shape bug. The spoke must ERROR, never
    // store publicKey:"" (flair#822).
    return {
      paired: true,
      instance: identity.kind === "answer" ? {
        id: identity.row.id,
        publicKey: identity.row.publicKey,
        role: identity.row.role,
      } : null,
    };
  }
}

// ─── Sync endpoint ───────────────────────────────────────────────────────────

/** One pairing's one-time token claim: the check-then-consume of a token (FederationPair.post runs it under the token's lock). */
type PairingTokenClaim =
  | ({ kind: "consumed" } & StagedPairingToken)
  | { kind: "refused" }
  | { kind: "bootstrap_mismatch" };

/** The per-token lock namespace (resources/key-lock.ts); a token's lock key is its own. */
const PAIRING_TOKEN_LOCK_NAMESPACE = "flair-pairing-token";
/**
 * The token lock gets up to `PAIR_LOCK_ATTEMPTS` acquisition attempts, with
 * at most one fewer waits of `PAIR_LOCK_WAIT_MS` nominally between attempts.
 * Exhaustion refuses the pairing; timer spacing does not bound elapsed time.
 */
const PAIR_LOCK_ATTEMPTS = 200;
const PAIR_LOCK_WAIT_MS = 10;

/** 401 for a pair with no pairing token: a first-time pair, and a re-pair whose Peer row was deleted, both require one. */
function pairingTokenRequiredRefusal(): Response {
  return new Response(JSON.stringify({
    error: "pairingToken required in body for first-time pair",
  }), { status: 401, headers: { "content-type": "application/json" } });
}

/** 409 for a re-pair whose signed request's key is not the peer row's pinned public key. */
function publicKeyMismatchRefusal(): Response {
  return new Response(JSON.stringify({
    error: "public key mismatch — peer already paired with different key",
  }), { status: 409, headers: { "content-type": "application/json" } });
}

/** The Peer row a first-time pair builds without an earlier Peer row. */
function firstPairPeerRow(instanceId: string, publicKey: string, role: unknown, endpoint: unknown) {
  const at = new Date().toISOString();
  return {
    id: instanceId,
    publicKey,
    role: role ?? "spoke",
    endpoint: endpoint ?? null,
    status: "paired",
    relayOnly: false,
    pairedAt: at,
    createdAt: at,
    updatedAt: at,
  };
}

type StagedPairingToken = { consumedBy: string; consumedAt: string; pairAttemptWriteId: string };

/**
 * A staged Peer row. `pairAttemptWriteId` is the id of the pairing attempt that
 * last wrote this field: a LAST-WRITER marker for the field, not a
 * last-confirmed marker for the row. Harper merges a field-level competing
 * update with a staged write that commits around it, so a refused attempt's id
 * can remain on a row whose other fields are the competitor's. The post-commit
 * check in confirmTokenPairAfterCommit reads it as the id of this attempt's
 * staged write; its presence does not report the attempt as confirmed.
 */
type StagedPairPeer = { id: string; pairAttemptWriteId: string } & Record<string, unknown>;

async function confirmFirstPairBeforeCommit(instanceId: string): Promise<void> {
  await confirmCommittedRow((databases as any).flair.Peer, instanceId, (committed) => committed == null);
  const commitPause = txnPausePoint("federation-pair-first-commit");
  if (commitPause) await commitPause;
}

async function confirmTokenPairAfterCommit(pairingToken: string, stagedPeer: StagedPairPeer, stagedToken: StagedPairingToken, firstPair = true): Promise<Response | undefined> {
  if (firstPair) {
    const readBackPause = txnPausePoint("federation-pair-first-read-back");
    if (readBackPause) await readBackPause;
  }
  const unreadableRefusal = firstPair ? firstPairReadBackUnconfirmedRefusal : firstPairCommitUnconfirmedRefusal;
  // A re-pair's staged row spreads the re-read row, so its compared fields are
  // its application fields (Harper's own timestamps left out); a first pair's
  // staged row is built from the request and is compared whole.
  const peerFields = firstPair ? stagedPeer : withoutHarperManagedFields(stagedPeer);
  const peerVerdict = await verifyCommittedFields((databases as any).flair.Peer, stagedPeer.id, stagedPeer, peerFields);
  let tokenRow: any;
  try {
    tokenRow = await (databases as any).flair.PairingToken.get(pairingToken, {});
  } catch {
    return unreadableRefusal();
  }
  if (peerVerdict === "unreadable") return unreadableRefusal();
  if (peerVerdict !== "shown" || tokenRow?.pairAttemptWriteId !== stagedToken.pairAttemptWriteId ||
    tokenRow?.consumedBy !== stagedToken.consumedBy || tokenRow?.consumedAt !== stagedToken.consumedAt) return firstPairCommitUnconfirmedRefusal();
  return undefined;
}

/**
 * Drop the bootstrap user that was created alongside this pairing token, after a
 * first-time pair consumed it. Failure here is logged and non-fatal.
 */
async function dropPairBootstrapUser(pairingToken: string, ctx: any): Promise<void> {
  try {
    const bootstrapUsername = `pair-bootstrap-${pairingToken.slice(0, 8)}`;
    await server.operation(
      { operation: "drop_user", username: bootstrapUsername },
      ctx,
      false,
    );
  } catch (err: any) {
    console.warn(`[federation] drop_user failed: ${err?.message} — cleanup sweep will retry`);
  }
}

/** 403 for a re-pair of a revoked peer: a revoke is a local decision, and a re-pair does not restore it. */
function peerRevokedRefusal(): Response {
  return new Response(JSON.stringify({
    error: "peer_revoked",
    message: "this Peer row is revoked; it stays revoked",
  }), { status: 403, headers: { "content-type": "application/json" } });
}

/**
 * 409 for a first-time pair whose committed-state confirm found a Peer row for
 * the instance although its earlier read returned none. The owned
 * transaction aborted: this request wrote no Peer row and did not consume the
 * pairing token.
 * Signature verification recorded the request's replay nonce before pairing
 * began; that record stays.
 */
function firstPairRowAppearedRefusal(): Response {
  return new Response(JSON.stringify({
    error: "peer_row_appeared",
    outcome: "conflict",
    message: "a Peer row for this instance is in committed state although this pairing's earlier read found none; this request wrote no Peer row and did not consume the pairing token",
  }), { status: 409, headers: { "content-type": "application/json" } });
}

/** 409 for a token pair whose committed Peer row and pairing token consume
 *  could not be confirmed as this attempt's after the commit: on a first-time
 *  pair, the committed rows do not show the staged values; on a token re-pair of
 *  an existing Peer, they do not show them or could not be read. The
 *  non-idempotent pair is not retried and is not reported as `paired`. */
function firstPairCommitUnconfirmedRefusal(): Response {
  return new Response(JSON.stringify({
    error: "peer_pair_unconfirmed",
    outcome: "unconfirmed",
    message: "this pairing attempt's committed Peer row and pairing token consume could not be confirmed; the paired state is unconfirmed",
  }), { status: 409, headers: { "content-type": "application/json" } });
}

/** 503 for a first-time pair whose committed Peer row or PairingToken row
 *  could not be read back; the stored state is unconfirmed and the request did
 *  not answer `paired`. */
function firstPairReadBackUnconfirmedRefusal(): Response {
  return new Response(JSON.stringify({
    error: "peer_read_back_unconfirmed",
    outcome: "unconfirmed",
    message: "the committed Peer row or pairing token could not be read back; this pairing's stored state is unconfirmed",
  }), { status: 503, headers: { "content-type": "application/json" } });
}

/**
 * Tag a token-supplying re-pair's Peer.put rejection inside the owned transaction
 * callback (flair#2333), so it aborts before the caller returns peer_write_failed.
 */
class PeerWriteFailedError extends Error {
  constructor(readonly cause: unknown) {
    super("re-pair Peer write failed");
    this.name = "PeerWriteFailedError";
  }
}

/**
 * A token-supplying re-pair's Peer re-read found a revoked row (flair#2333).
 * The transaction aborts, so the token claim that ran with it
 * rolls back and the token is left unconsumed; the caller answers the revoked
 * refusal, not a bare 500.
 */
class PeerRevokedDuringRepairError extends Error {
  constructor() {
    super("re-pair Peer row revoked inside the owned transaction");
    this.name = "PeerRevokedDuringRepairError";
  }
}

/**
 * A token-supplying re-pair's Peer re-read found a pinned key unlike the request's
 * key (flair#2333). The transaction aborts, so the token claim that ran with it
 * rolls back and the token is left unconsumed; the caller answers the key-mismatch
 * refusal, not a bare 500.
 */
class PeerKeyChangedDuringRepairError extends Error {
  constructor() {
    super("re-pair Peer row's pinned key differs from the signed request's key on the owned transaction's re-read");
    this.name = "PeerKeyChangedDuringRepairError";
  }
}

/**
 * 503 for a token-supplying re-pair whose Peer.put rejected inside the owned
 * transaction callback. The token consume and Peer write rolled back; the
 * replay nonce remains recorded. The token is retryable while valid.
 */
function peerWriteFailedRefusal(): Response {
  return new Response(JSON.stringify({
    error: "peer_write_failed",
    message: "the re-pair's Peer write failed; neither the token consume nor the Peer write committed — the pairing token is unconsumed and retryable while valid, retry",
  }), { status: 503, headers: { "content-type": "application/json" } });
}

/**
 * Run one pairing token's check-and-consume under that token's per-key lock
 * (flair#2333), and map the outcome to the refusal the caller returns. `fn`
 * runs only when the lock is held and the store has a lock; `undefined` means
 * `fn` ran and its claim consumed the token (any other claim maps to its refusal
 * through `pairingTokenRefusal`).
 *
 * The lock is the PairingToken store's per-key lock (resources/key-lock.ts): it
 * is shared by this ONE Harper node's threads, so it excludes concurrent
 * pairings of the same token WITHIN one Flair node. Harper can run several
 * nodes for one instance; the lock is not shared across them (see the PR body).
 */
async function withPairingTokenClaim(
  pairingToken: string,
  fn: () => Promise<PairingTokenClaim>,
): Promise<Response | undefined> {
  const outcome = await withKeyLock(
    (databases as any).flair.PairingToken?.primaryStore,
    [PAIRING_TOKEN_LOCK_NAMESPACE, pairingToken],
    fn,
    PAIR_LOCK_ATTEMPTS,
    PAIR_LOCK_WAIT_MS,
  );
  if (outcome.kind === "busy") {
    return new Response(JSON.stringify({
      error: "pairing_in_progress",
      message: "another pairing of this token is still in progress; retry",
    }), { status: 409, headers: { "content-type": "application/json" } });
  }
  if (outcome.kind === "unavailable") {
    return new Response(JSON.stringify({
      error: "pairing_lock_unavailable",
      message: "this instance's PairingToken store has no per-key lock, so the pairing was refused",
    }), { status: 503, headers: { "content-type": "application/json" } });
  }
  return pairingTokenRefusal(outcome.value);
}

/** The refusal a finished pairing-token claim maps to, or `undefined` when it consumed the token. */
function pairingTokenRefusal(claim: PairingTokenClaim): Response | undefined {
  if (claim.kind === "consumed") return undefined;
  if (claim.kind === "bootstrap_mismatch") {
    return new Response(JSON.stringify({
      error: "bootstrap_user_token_mismatch",
    }), { status: 401, headers: { "content-type": "application/json" } });
  }
  return new Response(JSON.stringify({ error: "invalid_or_expired_pairing_token" }), {
    status: 401, headers: { "content-type": "application/json" },
  });
}

/**
 * The check-then-consume of one pairing token, run while holding that token's
 * per-key lock (FederationPair.post). The token is re-read on entry: a pairing
 * that consumed it first makes this one refuse. On success the token records
 * `consumerInstanceId` and is consumed.
 */
async function consumePairingToken(
  pairingToken: string,
  consumerInstanceId: string,
  ctx: any,
): Promise<PairingTokenClaim> {
  // Fetch the token record for consumption IN the caller's transaction — the
  // fresh OWNED one the claim runs in (withOwnedTransaction), never the request's
  // earlier read snapshot. Harper's transaction() set `ctx.transaction`, so the
  // read sees committed state and the write below commits with it.
  let tokenRecord: any = null;
  try {
    tokenRecord = await (databases as any).flair.PairingToken.get(pairingToken, ctx);
  } catch { /* table may not exist */ }

  const pause = txnPausePoint("federation-pair-token");
  if (pause) await pause;

  if (!tokenRecord || tokenRecord.consumedBy) {
    return { kind: "refused" };
  }
  if (tokenRecord.expiresAt && new Date(tokenRecord.expiresAt) < new Date()) {
    return { kind: "refused" };
  }

  // PR-4: bind authenticated bootstrap user to specific pairing token.
  // The middleware annotates the REQUEST (request.tpsAgent); getContext() IS
  // that request (resources/Resource.js getResource), not a wrapper with a
  // `.request` field — the same read A2AAdapter uses (`ctx.request ?? ctx`).
  const ctxRequest: any = ctx?.request ?? ctx ?? {};
  const authedUser = ctxRequest.tpsAgent;
  const isAdmin = ctxRequest.tpsAgentIsAdmin === true;
  if (!isAdmin && authedUser) {
    const expectedBootstrap = `pair-bootstrap-${pairingToken.slice(0, 8)}`;
    if (authedUser !== expectedBootstrap) {
      return { kind: "bootstrap_mismatch" };
    }
  }

  // Consume the token. A fresh random `pairAttemptWriteId` is written here in
  // the same transaction as the first-pair Peer write; after the commit,
  // both first-pair routes confirm BOTH committed rows by that marker, so an attempt
  // that merely shares `consumedAt` or staged Peer values cannot pass.
  const consumedAt = new Date().toISOString();
  const pairAttemptWriteId = randomUUID();
  await (databases as any).flair.PairingToken.put({
    ...tokenRecord,
    consumedBy: consumerInstanceId,
    consumedAt,
    pairAttemptWriteId,
  }, ctx);
  return { kind: "consumed", consumedBy: consumerInstanceId, consumedAt, pairAttemptWriteId };
}

const RECORD_MERGE_DEADLINE_MS = 5_000;

/**
 * POST /FederationSync — push sync records from a peer.
 * In 1.0, this is a simple HTTP push (not WebSocket).
 * The calling peer sends a batch of SyncRecords; we merge them.
 */
export class FederationSync extends Resource {
  // Public endpoint by design: spokes have no Harper credentials. Body signature
  // (with timestamp + nonce, via verifyFederationRequestBody) is the auth boundary.
  // Same pattern as FederationPair.
  allowCreate(_user: any, _record: any, _context: any) {
    return true;
  }

  async post(data: any) {
    const { instanceId, records, lamportClock, signature } = data || {};

    if (!instanceId || !Array.isArray(records)) {
      return new Response(JSON.stringify({ error: "instanceId and records[] required" }), {
        status: 400, headers: { "content-type": "application/json" },
      });
    }

    // Verify peer is known
    const peer = await (databases as any).flair.Peer.get(instanceId);
    if (!peer || peer.status === "revoked") {
      return new Response(JSON.stringify({ error: "unknown or revoked peer" }), {
        status: 403, headers: { "content-type": "application/json" },
      });
    }

    // Verify request signature against peer's pinned public key.
    // Fresh verification with anti-replay — prevents captured signatures from
    // being replayed across the timestamp window.
    if (!signature) {
      return new Response(JSON.stringify({ error: "signature required — sync requests must be signed" }), {
        status: 401, headers: { "content-type": "application/json" },
      });
    }
    const verifyResult = await verifyFederationRequestBody(data, peer.publicKey);
    if (!verifyResult.ok) return federationVerifyRefusal(verifyResult.reason);

    const offeredKeys = new Set<string>();
    for (const record of records) {
      if (typeof record?.table !== "string" || record.table.length === 0 ||
        typeof record?.id !== "string" || record.id.length === 0 ||
        record?.data?.id !== record.id) {
        return new Response(JSON.stringify({ error: "invalid_sync_batch_key" }), {
          status: 400, headers: { "content-type": "application/json" },
        });
      }
      const key = JSON.stringify([record.table, record.id]);
      if (offeredKeys.has(key)) {
        return new Response(JSON.stringify({ error: "duplicate_sync_batch_key" }), {
          status: 400, headers: { "content-type": "application/json" },
        });
      }
      offeredKeys.add(key);
    }

    const startTime = Date.now();
    let merged = 0;
    let skipped = 0;
    const skippedReasons: Record<string, number> = {};
    const refused: Array<{ table: string; id: string; reason: SkipReason }> = [];
    const indeterminate: Array<{ table: string; id: string }> = [];
    const mergeErrors: string[] = [];

    function recordSkip(reason: SkipReason, record: SyncRecord) {
      skipped++;
      skippedReasons[reason] = (skippedReasons[reason] ?? 0) + 1;
      refused.push({ table: record.table, id: record.id, reason });
    }

    // Table name → Harper database table mapping.
    // Typed against FEDERATION_TABLE_POLICY so adding a federated table
    // without deciding principalOwning is a type error, not a silent
    // default (flair#1416 — refuse by whitelist, never by field presence).
    const tableMap: Record<FederationSyncTable, any> = {
      Memory: (databases as any).flair.Memory,
      Soul: (databases as any).flair.Soul,
      Agent: (databases as any).flair.Agent,
      Relationship: (databases as any).flair.Relationship,
      // Flair Relay (flair#1521). Registered so the policy + owner-field land now
      // (the design's ship-order). No spoke pushes Message records in S1 — this is the
      // RECEIVE side only; the absorbing-state guard below keeps an incoming
      // Message merge from ever regressing a locally-consumed row (§12 P0-3).
      //
      // S2 COMMENT-PIN (Kern P1-4, flair#1521): the receive-only carve-out means
      // an incoming Message record is verified only at the RECORD level (batch
      // signature, per-record originator signature, principalId == `from`) — the
      // ENVELOPE's own signature + contentHash (relay-lib.ts verifyMessageSignature)
      // NEVER runs on this merge path. Correct for S1 (nothing pushes Message).
      // But the FIRST hub that pushes Message would merge unverified envelope
      // content silently: S2 MUST add envelope verification here (or an explicit
      // trust delegation to the originator's send-time check) alongside adding
      // Message to the push list — do not inherit this as a silent gap.
      Message: (databases as any).flair.Message,
      // flair#2578 slice 1: Presence is REGISTERED so the receive path can carry
      // it (the receiver writes it through the write-back helper). The sender
      // ships in a later slice — this is the RECEIVE side only.
      Presence: (databases as any).flair.Presence,
    };
    const knownTables = new Set(Object.keys(tableMap));

    type MergeOutcome = { reason: SkipReason } | { merged: true } | { indeterminate: true };

    /** Read the local Agent row for an id, or null when there is none.
     *  Read failures throw: before write-back starts they become retryable
     *  `merge_error`; after it starts they are indeterminate. */
    const readAgentRow = async (agentId: string): Promise<Record<string, any> | null> => {
      const row = await (databases as any).flair.Agent.get(agentId);
      return row ?? null;
    };

    // ── flair#2578 slice 1: Presence receipt (P1, P4, P5) ──
    // The batch-verified sender (`sender`) is the home authority. Write-back
    // rechecks the home fresh and reads the Presence row in its owned transaction.
    const mergePresence = async (
      record: SyncRecord,
      sender: string,
      local: Record<string, any> | null,
      table: any,
      markWriteStarted: () => void,
    ): Promise<MergeOutcome> => {
      const receivedAt = Date.now();
      // P5: strip to the declared Presence fields and validate. The wire record
      // id IS the primary key (agentId).
      const validated = validatePresenceReceipt(record.id, record.data, receivedAt, sender);
      if (!validated.ok) return { reason: validated.reason };
      const agentId = validated.row.agentId as string;

      // P1: the Agent row must be homed on the batch-verified sender.
      const homeReason = presenceHomeBindingReason(await readAgentRow(agentId), sender);
      if (homeReason) return { reason: homeReason };

      // P4: Presence-specific merge (heartbeat, then activity stamp).
      const planned = mergePresenceReceipt(local, validated.row, receivedAt);
      if (planned.action === "skip") return { reason: planned.reason };

      // As in the generic merge: write-back conflicts aborted before commit are
      // merge_target_changed; other errors after write-back starts are indeterminate.
      let outcome: any;
      markWriteStarted();
      try {
        outcome = await writeBackCommittedRow(
          table,
          record.id,
          async (row) => {
            // Fresh home recheck during write-back; `row` is the transaction-scoped
            // Presence read.
            const currentHome = presenceHomeBindingReason(await readAgentRow(agentId), sender);
            if (currentHome) return { skip: true, reason: currentHome };
            const current = mergePresenceReceipt(row, validated.row, receivedAt);
            if (current.action === "skip") return { skip: true, reason: current.reason };
            return { idempotent: true, write: current.row };
          },
          {
            label: "FederationSync",
            expectedRow: local,
            attempts: 1,
            wholeRow: true,
            pausePre: () => txnPausePoint("presence-merge-pre"),
            pausePoint: () => txnPausePoint("presence-merge"),
          },
        );
      } catch (err) {
        if (err instanceof WriteBackConflictError) {
          return err.outcome === "conflict" ? { reason: "merge_target_changed" } : { indeterminate: true };
        }
        throw err;
      }
      if ("skip" in outcome) {
        return { reason: (outcome.reason as SkipReason | undefined) ?? "presence_invalid_shape" };
      }
      return { merged: true };
    };

    const mergeOne = async (record: SyncRecord): Promise<MergeOutcome> => {
      let writeBackStarted = false;
      try {
        if (payloadIdMismatch(record)) {
          return { reason: "id_mismatch" };
        }
        const table = (record.table in tableMap)
          ? tableMap[record.table as FederationSyncTable]
          : undefined;
        const local = table ? await table.get(record.id) : null;

        const decision = classifyRecord(
          record,
          peer.role,
          instanceId,
          local,
          knownTables,
        );

        if (decision.action === "skip") {
          return { reason: decision.reason };
        }

        // With the flag OFF, an eligible Presence record reaching receipt skips
        // as presence_receive_disabled; earlier key/classifier refusals answer first.
        if (record.table === "Presence" && !presenceReceiveEnabled()) {
          return { reason: "presence_receive_disabled" };
        }

        // ── Per-record signature verification (federation-edge-hardening slice 3b) ──
        // classifyRecord's "merge" verdict above only proves the record is
        // STRUCTURALLY eligible (known table, self-originated OR the sender
        // is a hub, not stale, not a no-op) — that hub bypass trusts the
        // BATCH-level signature (verifyFederationRequestBody above, verified
        // against the SENDER's pinned key). It does NOT prove the record's
        // *claimed* originator actually produced it — a hub relaying on
        // behalf of many spokes could otherwise forge a record under any
        // originatorInstanceId it likes, and the receiver had no way to
        // tell. This gate closes that hole: verify the record's own
        // signature (§3a, set at push-time by the ORIGINATOR, never by
        // whoever relayed it) against the ORIGINATOR's pinned instance key
        // — never the sender's key.
        //
        // A bad/unverifiable signature skips ONLY this record, never the
        // batch — rejecting the whole batch on one bad record would be a
        // DoS vector (one forged/garbled record could blackhole every other
        // legitimate record riding along in the same POST).
        const originator = decision.originator;
        if (record.signature) {
          const originatorPublicKey = originator === instanceId
            ? peer.publicKey
            : (await (databases as any).flair.Peer.get(originator))?.publicKey;

          if (!originatorPublicKey) {
            return { reason: "unknown_originator_key" };
          }

          // CONTRACT — reconstruct from the record (v defaults to 1 when
          // absent — v is NOT on the wire today). Must match
          // reconstructRecordVerifyBody / src/cli.ts's signing payload.
          // A hardcoded { v: 1, table, id, data, updatedAt,
          // originatorInstanceId } field set can only ever verify one
          // shape; building from the record is what makes v:2 (principalId
          // in the signed body) verifiable without breaking existing
          // records. See flair#1416.
          const signatureValid = verifyBodySignature(
            reconstructRecordVerifyBody(record, originator),
            originatorPublicKey,
          );
          if (!signatureValid) {
            return { reason: "invalid_signature" };
          }
        } else if (requireRecordSignatures()) {
          // require-mode: unsigned records are no longer trusted on
          // batch-level auth alone. Default mode (verify-if-present) falls
          // through here and merges — see requireRecordSignatures() above.
          return { reason: "missing_signature" };
        }

        // ── Per-record principal entitlement (flair#1416 / slice 3a) ──
        // After signature verification, before table.put. Scoped by the
        // explicit PRINCIPAL_OWNING_TABLES set (Memory), never by whether
        // principalId happens to be present — absent Memory principalId
        // is a skip, not an accept. Soul/Agent/Relationship are not in
        // the set and are not consulted. No Agent.get.
        const principalSkip = checkPrincipalEntitlement(record, {
          enforceV1Principal: requireRecordPrincipal(),
        });
        if (principalSkip) {
          return { reason: principalSkip };
        }

        // ── flair#2578 slice 1: Presence receipt ──
        if (record.table === "Presence") {
          return await mergePresence(record, instanceId, local, table, () => { writeBackStarted = true; });
        }

        const incoming = { ...record.data };
        if (record.table === "Memory") {
          // Ephemeral peer expiry must be a valid UTC ISO date from the Unix
          // epoch through receiver time + 365 days. Missing expiry uses the receiver's
          // clock and configured TTL when the incoming row wins last-write-wins.
          // Malformed or out-of-bound ephemeral expiry skips the record before merging.
          const expiryError = stampEphemeralExpiry(incoming, local, { incoming: true });
          if (expiryError) {
            return { reason: "invalid_expiry" };
          }
        }
        const mergedData = mergeRecord(local, { ...record, data: incoming });

        // ── flair#2359: an inbound Agent row must satisfy the same agent-ID
        // rule as a locally-created one. This raw merge is the receiver's write
        // path, so a peer pushing a malformed id must not land a row here.
        if (record.table === "Agent" && !isValidAgentId(record.id)) {
          return { reason: AGENT_ID_ERROR };
        }

        // ── flair#1940 A1'' item 8: the SAME declared-attribute whitelist the
        // writers apply. A dirty pushed row (a legacy direct-insert, or a raw
        // writer that slipped a pointer field past the writers) must not carry
        // a pointer attribute onto the merged Memory row here either. The named
        // federation bookkeeping fields (_originatorInstanceId, _syncedFrom,
        // _syncedAt, meta, kind) are on the whitelist and survive.
        if (record.table === "Memory") {
          stripInboundMemoryRow(mergedData);
        }

        // ── flair#1542: skills are not federated ──
        // A skill-tagged Memory is a local, gated artifact (SkillScan + forced
        // durability on the write path). Merging a pushed skill-tagged row RAW
        // would land an unscanned, possibly non-persistent skill — bypassing the
        // gate. Skip it: skills are written locally via skill_store, never synced.
        if (record.table === "Memory" && isSkillWrite(mergedData)) {
          return { reason: "skill_not_federated" };
        }

        // flair#2141 S2: the merge skips a row on the seed's fixed id
        // (resources/seed-reservation.ts), whatever its tags.
        if (isReservedSeedId(record.table, record.id)) {
          return { reason: "seed_id_not_federated" };
        }

        // flair#2307: Harper's REST by-id path reads a trailing `.content` as a
        // property selector, and the Memory write paths refuse such an id, so a
        // federated Memory row whose id ends in `.content` is skipped, as the
        // seed reservation does just above. A legacy row with such an id that
        // already exists on the sending peer is therefore not federated.
        if (record.table === "Memory" && endsWithContentSelectorSuffix(mergedData.id)) {
          return { reason: "content_suffix_id_not_federated" };
        }

        mergedData._originatorInstanceId = decision.originator;
        mergedData._syncedFrom = instanceId;
        mergedData._syncedAt = new Date().toISOString();
        // Re-assert the whitelist AFTER stamping the bookkeeping fields, so a
        // dirty inbound row cannot smuggle a pointer field through this merge
        // even if it also carried one of the allowed keys.
        if (record.table === "Memory") {
          stripInboundMemoryRow(mergedData);
          // A1-iv items 1/3: a federated receive is a LOCAL incarnation — the
          // token is OURS, never the peer's. Drop a peer-supplied server-stamped
          // field, then PRESERVE the local row's token on a merge (a new row
          // gets a locally-generated one).
          //
          // Round 22: `provenance` is NOT a local incarnation stamp — it is the
          // ORIGINATOR's signed stamp and must survive the merge. Capture the
          // value mergeRecord SELECTED (the inbound data for a new row; the
          // merge's LWW choice for an update — NOT always local.provenance)
          // before stripping, then restore it in the same per-record apply.
          // Pinned by test/unit-isolated/federation-merge-provenance.test.ts —
          // RED if this capture/restore is removed.
          const mergedProvenance = mergedData.provenance;
          stripServerStampedFields(mergedData);
          if (typeof mergedProvenance === "string") {
            mergedData.provenance = mergedProvenance;
          }
          mergedData.instanceToken =
            local && typeof local.instanceToken === "string" && local.instanceToken.length > 0
              ? local.instanceToken
              : randomUUID();
        }

        // flair#2441 / flair#2450 / flair#2475: every synced table uses the
        // write-back helper (one attempt, no retry). The plan reads the
        // in-transaction row. The Agent status guard can skip as
        // agent_status_not_federated before row comparison. For planned writes,
        // every table compares the WHOLE stored row against `local` (the row the
        // merge read and built from): a change to any field committed between that
        // read and the helper's in-transaction read skips the record as
        // merge_target_changed. The committed row is checked again before commit.
        //
        // flair#2450 set `wholeRow` for Soul, Agent, Relationship and Message;
        // flair#2475 extends it to Memory: Memory's identity fields
        // (instanceToken, contentHash, createdAt, agentId) do not move on a
        // field-only update, and the merge writes the whole row, so an
        // identity-only check let it put back the changed field's pre-change
        // value.
        let outcome: any;
        writeBackStarted = true;
        try {
          outcome = await writeBackCommittedRow(
            table,
            record.id,
            (row) => {
              // flair#2108: an inbound Agent record whose `status` differs from
              // the in-transaction local principal's stored value is skipped WHOLE,
              // whether or not it would win the last-write-wins merge — the
              // federation path carries no verified administrator authority for
              // that principal (the batch is signed, and a record signature may
              // also be present; neither is an admin claim), so a second field
              // in the record does not land either.
              if (record.table === "Agent" && inboundChangesExistingPrincipalStatus(record, row)) {
                return { skip: true, reason: "agent_status_not_federated" };
              }
              // flair#2266: skip an inbound Agent record carrying a publicKey
              // different from stored `pending`, regardless of timestamps.
              if (record.table === "Agent" && inboundChangesExistingPendingKey(record, row)) {
                return { skip: true, reason: "agent_pending_key_not_federated" };
              }
              // flair#2665: a new row whose id the receiver's FLAIR_ADMIN_AGENTS
              // names is not created. An existing row's publicKey and home
              // change only through a record whose batch-verified sender
              // (`instanceId`) is the row's stored home; a record from another
              // sender that would change either is skipped whole. The merge
              // does not set or change the `role: "admin"` / `admin: true`
              // fields.
              if (record.table === "Agent") {
                const agentRefusal =
                  agentAdminIdCreateRefusal(record, row, configuredAdminAgentIds()) ??
                  agentIdentityRefusal(record, row, instanceId);
                if (agentRefusal) return { skip: true, reason: agentRefusal };
                keepReceiverAgentAuthority(mergedData, row);
              }
              // Absorbing-state guard for the Message table (flair#1521 §12
              // P0-3). Generic newer-wins LWW would let a deadline-sweep `failed`
              // (or any other state) written on a peer overwrite a locally-
              // CONSUMED message, telling the sender "failed" about a message the
              // recipient actually consumed — the exact inversion Relay exists to
              // kill. `consumed` is absorbing: reconcileState pins it regardless
              // of updatedAt, against the in-transaction row's state. For consumed
              // state, clear failureReason and prefer the in-transaction row's
              // consumedAt when non-null.
              if (record.table === "Message") {
                const reconciled = reconcileState(row?.state, mergedData.state);
                mergedData.state = reconciled;
                if (reconciled === "consumed") {
                  mergedData.failureReason = null;
                  mergedData.consumedAt = row?.consumedAt ?? mergedData.consumedAt ?? null;
                }
              }
              if (record.table === "Memory") normalizeEmptyEmbedding(mergedData);
              return { idempotent: true, write: mergedData };
            },
            {
              label: "FederationSync",
              expectedRow: local,
              attempts: 1,
              // Planned writes compare the whole stored row, not just
              // sameStoredRow's identity fields: Memory's identity fields do not
              // move on a field-only update (flair#2475), and the other tables'
              // identity fields do not move on one either (flair#2450 — see
              // above).
              wholeRow: true,
              pausePre: () => txnPausePoint("federation-merge-pre"),
              pausePoint: () => txnPausePoint("federation-merge"),
            },
          );
        } catch (err) {
          if (err instanceof WriteBackConflictError) {
            return err.outcome === "conflict" ? { reason: "merge_target_changed" } : { indeterminate: true };
          }
          throw err;
        }
        // Each skip above carries its OWN name on the plan's `reason`; the
        // fallback is the status rule's name for any future skip that does not.
        // (Every skip this plan returns names a reason today.)
        if ("skip" in outcome) {
          return { reason: outcome.reason ?? "agent_status_not_federated" };
        }
        try {
          noteFederationMergedMemory(record.table, mergedData, local ?? null);
        } catch (err) {
          console.warn(`[Federation] post-commit note failed for ${record.table}/${record.id}: ${String(err)}`);
        }
        return { merged: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Cap the captured-error list so a hostile/buggy peer can't blow up
        // the SyncLog row, but ALWAYS log to console so operators don't lose
        // the per-record signal — the silent-swallow is the bug we're fixing.
        if (mergeErrors.length < 10) {
          mergeErrors.push(`${record.table}/${record.id}: ${msg}`);
        }
        console.warn(
          `[Federation] merge error for ${record.table}/${record.id} from ${instanceId}: ${msg}`,
        );
        return writeBackStarted ? { indeterminate: true } : { reason: "merge_error" };
      }
    };

    for (const record of records as SyncRecord[]) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<MergeOutcome>((resolve) => {
        timer = setTimeout(() => resolve({ indeterminate: true }), RECORD_MERGE_DEADLINE_MS);
      });
      let outcome: MergeOutcome;
      try {
        outcome = await Promise.race([mergeOne(record), deadline]);
      } finally {
        clearTimeout(timer);
      }
      if ("reason" in outcome) recordSkip(outcome.reason, record);
      else if ("merged" in outcome) merged++;
      else indeterminate.push({ table: record.table, id: record.id });
    }

    // Peer cursor update — distinguish liveness from progress:
    //   lastSyncAt → "we heard from this peer just now" (always update)
    //   lastMergeAt → "data actually flowed in" (only when merged > 0)
    // Conflating them produced the "green dashboard while burning" failure
    // mode — dogfood pass 2026-05-26 surfaced unconditional update masking
    // 100%-skip syncs.
    const nowIso = new Date().toISOString();
    const peerUpdate: Record<string, any> = {
      ...peer,
      lastSyncAt: nowIso,
      lastSyncCursor: lamportClock?.toString() ?? nowIso,
      status: "connected",
      updatedAt: nowIso,
    };
    if (merged > 0) {
      peerUpdate.lastMergeAt = nowIso;
    }
    await (databases as any).flair.Peer.put(peerUpdate);

    // Log sync operation with skip-reason breakdown so the partial state
    // is debuggable instead of a black box.
    try {
      const errorParts: string[] = [];
      if (Object.keys(skippedReasons).length > 0) {
        errorParts.push(
          "skipped: " +
            Object.entries(skippedReasons)
              .map(([reason, n]) => `${n} ${reason}`)
              .join(", "),
        );
      }
      if (mergeErrors.length > 0) {
        errorParts.push("merge_errors: " + mergeErrors.join("; "));
      }
      const errorSummary = errorParts.length > 0 ? errorParts.join(" | ") : undefined;
      const status = mergeErrors.length > 0
        ? "partial"
        : skipped > 0 || indeterminate.length > 0 ? "partial" : "success";

      await (databases as any).flair.SyncLog.put({
        id: `sync_${Date.now()}_${randomBytes(4).toString("hex")}`,
        peerId: instanceId,
        direction: "pull",
        recordCount: merged,
        skippedCount: skipped,
        skippedReasons: JSON.stringify(skippedReasons),
        status,
        error: errorSummary,
        durationMs: Date.now() - startTime,
        createdAt: nowIso,
      });
    } catch { /* non-fatal */ }

    return {
      merged,
      skipped,
      skippedReasons,
      refused,
      indeterminate,
      total: records.length,
      durationMs: Date.now() - startTime,
    };
  }
}

/**
 * GET /FederationPeers — list known peers (admin view).
 *
 * allowRead()=allowAdmin (defense-in-depth, authorizeLocal-escalation-class
 * follow-up to #601/#604/#609/#612 — flair#614's backstop found this one had
 * NO allow* at all). The docstring already called this "(admin view)" — this
 * closes the gap between the documented/intended access model and what was
 * actually enforced (nothing).
 */
export class FederationPeers extends Resource {
  async allowRead(): Promise<boolean> {
    return allowAdmin((this as any).getContext?.());
  }

  async get() {
    const peers: any[] = [];
    try {
      for await (const p of (databases as any).flair.Peer.search()) {
        peers.push({
          id: p.id,
          role: p.role,
          status: p.status,
          endpoint: p.endpoint,
          lastSyncAt: p.lastSyncAt,
          lastMergeAt: p.lastMergeAt,
          presenceLastSyncAt: p.presenceLastSyncAt,
          relayOnly: p.relayOnly,
          pairedAt: p.pairedAt,
        });
      }
    } catch {}
    return { peers };
  }
}

/**
 * GET /FederationRetries — the rows of the sender's FederationRetry table
 * (flair#2455), admin view, split into `pending`, `terminal` and `malformed`.
 * No production sender path creates rows yet (a later slice activates the
 * sender); rows an admin writes are readable now.
 *
 * A row that breaks a sender convention (retryRowProblem: an id that is not its
 * tuple's key, an unknown state, reason or outcome) is listed under
 * `malformed` with the problem's name, and never as pending or terminal.
 *
 * allowRead()=allowAdmin, the same gate as FederationPeers above. Read-only:
 * it never writes a row, and a read failure propagates instead of being
 * reported as an empty set. `flair federation status` renders it.
 */
export class FederationRetries extends Resource {
  async allowRead(): Promise<boolean> {
    return allowAdmin((this as any).getContext?.());
  }

  async get() {
    const pending: any[] = [];
    const terminal: any[] = [];
    const malformed: any[] = [];
    for await (const r of (databases as any).flair.FederationRetry.search()) {
      const problem = retryRowProblem(r);
      if (problem) {
        malformed.push({ key: r.id, peerId: r.peerId, table: r.table, id: r.recordId, state: r.state, problem });
        continue;
      }
      const row = {
        peerId: r.peerId,
        table: r.table,
        id: r.recordId,
        reason: r.lastReason,
        attempts: r.attempts,
        bound: r.bound,
        resolution: r.resolution,
        state: r.state,
        firstRefusedAt: r.firstRefusedAt,
        completedAt: r.completedAt,
      };
      (r.state === "pending" ? pending : terminal).push(row);
    }
    return { pending, terminal, malformed };
  }
}

// ── Module initialisation ────────────────────────────────────────────────────
// Deferred: the cleanup sweep (PR-5) starts after the module graph resolves.
// In unit test environments (no Harper runtime), setTimeout never fires
// synchronously and import is safe. In the live Harper process, the sweep
// will start on the next event loop tick and runs only on hub instances.
if (typeof setTimeout !== "undefined") {
  setTimeout(() => {
    initFederationCleanup().catch((err: any) => {
      // Swallow — in test/resource-env the Harper databases may not be bound.
      // In production, initFederationCleanup handles its own error paths.
    });

    // Nonce eviction is the ReplayNonce table's own expiration (one scan per
    // instance, on Harper's last worker) — no sweep is started here.
  }, 0);
}
