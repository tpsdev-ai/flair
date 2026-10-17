/**
 * Pure classifier for federation sync records — no Harper imports.
 *
 * Extracted from Federation.ts so the decision can be unit-tested without
 * spinning up Harper's database module. The same SkipReason names are used
 * in SyncLog.skippedReasons so operators can grep for them.
 */
import { effectiveAgentStatus } from "./agent-status-guard.js";

export interface SyncRecord {
  table: string;
  id: string;
  data: Record<string, any>;
  updatedAt: string;
  originatorInstanceId: string;
  signature?: string;
  principalId?: string;
  /**
   * Signature-body version. Not on the wire for today's (v:1) records —
   * receivers MUST default absent `v` to 1. Spreading the record without
   * that default drops `v` from the canonical form and fails every existing
   * record (fail-closed, fleet-wide). See reconstructRecordVerifyBody().
   */
  v?: number;
}

export type SkipReason =
  | "unknown_table"
  | "non_originator"
  | "future_timestamp"
  | "no_op_same_hash"
  // ─── federation-edge-hardening slice 3b ──────────────────────────────────
  // Emitted by FederationSync.post's per-record signature verification gate
  // (resources/Federation.ts), NOT by classifyRecord — this function stays
  // pure/DB-free (verifying a signature against the originator's pinned key
  // requires a Peer table lookup). Listed here so operators can grep one
  // SkipReason union for every reason a record can be skipped, and so
  // SyncLog.skippedReasons stays a closed, typed vocabulary.
  | "unknown_originator_key" // record is signed, but its claimed originator
                              // has no pinned public key on file (unknown peer)
  | "invalid_signature" // record is signed, but the signature doesn't verify
                        // against the originator's pinned public key
  | "missing_signature" // require-mode is on (FLAIR_FEDERATION_REQUIRE_RECORD_SIGNATURES)
                         // and the record has no signature at all
  // ─── federation-edge-hardening slice 3a (principalId) ────────────────────
  // Emitted by FederationSync.post AFTER signature verification, NEVER by
  // classifyRecord. A v:2 record on a principal-owning table (see
  // PRINCIPAL_OWNING_TABLES) whose principalId is absent or does not equal
  // data.agentId. Absent is a skip, not an accept — deriving the
  // requirement from field presence would make the check opt-out.
  | "principal_mismatch"
  // ─── flair#1940 A1' item 5 (hostSource is NOT federated) ────────────────
  // A record whose data carries a pointer field (hostSource / hostSourceScope
  // / hostSourceVisibility) is refused, never merged. The pointer table
  // (MemoryHostSource) is absent from FEDERATION_TABLE_POLICY, so it is never
  // in the sync's table set either (an inbound "MemoryHostSource" row skips as
  // "unknown_table").
  | "pointer_not_federated"
  // ─── flair#2108 (an inbound Agent `status` that differs from the stored one) ──
  // Emitted by FederationSync.post's merge plan for a record that passed the
  // earlier sync checks: an inbound Agent record
  // whose effective status (a missing `status` counts as "active") differs from
  // an existing local Agent's effective stored status, also when the record is older than the stored row and would
  // lose the last-write-wins merge. The federation path carries no verified
  // administrator authority for that principal, so the whole record is skipped
  // rather than merged without `status`.
  | "agent_status_not_federated"
  // ─── flair#2266 (pending-key guard) ──
  // A record reaching the merge plan with publicKey different from stored `pending`,
  // unless the status guard refused it first. Earlier validation keeps its reason.
  | "agent_pending_key_not_federated"
  // Emitted by FederationSync.post before the row is read: the payload's id is
  // missing or is not the envelope's id, so the record is not applied.
  | "id_mismatch"
  | "invalid_expiry"
  // Emitted by FederationSync.post when row confirmation fails for a planned
  // merge write.
  // The initial check compares the whole stored row for every synced table;
  // the final check compares the committed row with the in-transaction read. A
  // change committed after that final check is not seen. Nothing was written on
  // a refusal (flair#2441, flair#2450, flair#2475).
  | "merge_target_changed"
  // ─── flair#2455 slice 1: the reasons recordSkip already emitted as bare
  // strings. Typing them closes the union at the sites that produced them;
  // the exhaustive SKIP_REASON_CLASS map below then forces a retryable /
  // non-retryable decision on every future addition.
  | "merge_error" // a per-record merge threw (see FederationSync.post's catch)
  | "invalid_agent_id" // an Agent row whose id fails isValidAgentId (AGENT_ID_ERROR)
  | "skill_not_federated" // a skill-tagged Memory is a local, gated artifact
  | "seed_id_not_federated" // a reserved seed id is never merged
  | "content_suffix_id_not_federated" // a Memory id ending in `.content`
  // ─── flair#2578 slice 1: office-wide Presence, receiver and local guard ──
  // Presence replication (spoke → hub) is behind ONE default-off receive flag.
  // With the flag off a known Presence record is skipped by its own name, so an
  // operator's SyncLog grep is not mislabelled `unknown_table` (Kern N5).
  | "presence_receive_disabled" // the receive flag is off (non-retryable)
  // The batch-verified SENDER is the only home authority (never the wire
  // originatorInstanceId). The local Agent row for data.agentId must be homed on
  // that sender (Sherlock F1, Kern 2).
  | "presence_agent_not_replicated" // the Agent row has not reached this receiver yet (retryable)
  | "presence_agent_homed_elsewhere" // the Agent row's home is another instance, or null (non-retryable)
  // Presence-specific merge (Sherlock F5, Kern 4): an older heartbeat never
  // replaces a newer one (non-retryable).
  | "presence_stale_heartbeat"
  // Receipt validation (Sherlock F4, Kern 5): a row that does not strip to the
  // declared Presence fields is never stored (non-retryable).
  | "presence_invalid_shape"
  // The inbound heartbeat/activity stamp is later than the receiver's clock plus
  // the same allowance classifyRecord uses (Sherlock NEW-1; non-retryable).
  | "presence_future_timestamp"
;

/**
 * Every SkipReason's retry class (flair#2455 design rev 2, K1/S3).
 *
 * The `satisfies Record<SkipReason, …>` makes this map EXHAUSTIVE: adding a
 * member to {@link SkipReason} without giving it a class here is a type error,
 * so no reason can silently default to non-retryable — which is the shape the
 * original bug came from.
 *
 * "retryable" means a later re-offer of the SAME record can merge: contention
 * can clear (`merge_target_changed`), transient storage failures can heal
 * (`merge_error`), receiver time catches up (`future_timestamp`), and an
 * authorized pairing can supply the key (`unknown_originator_key`; a retry
 * never changes trust). The other reasons are classified non-retryable.
 */
export const SKIP_REASON_CLASS = {
  unknown_table: "non_retryable",
  non_originator: "non_retryable",
  future_timestamp: "retryable",
  no_op_same_hash: "non_retryable",
  unknown_originator_key: "retryable",
  invalid_signature: "non_retryable",
  missing_signature: "non_retryable",
  principal_mismatch: "non_retryable",
  pointer_not_federated: "non_retryable",
  agent_status_not_federated: "non_retryable",
  agent_pending_key_not_federated: "non_retryable",
  id_mismatch: "non_retryable",
  invalid_expiry: "non_retryable",
  merge_target_changed: "retryable",
  merge_error: "retryable",
  invalid_agent_id: "non_retryable",
  skill_not_federated: "non_retryable",
  seed_id_not_federated: "non_retryable",
  content_suffix_id_not_federated: "non_retryable",
  presence_receive_disabled: "non_retryable",
  presence_agent_not_replicated: "retryable",
  presence_agent_homed_elsewhere: "non_retryable",
  presence_stale_heartbeat: "non_retryable",
  presence_invalid_shape: "non_retryable",
  presence_future_timestamp: "non_retryable",
} as const satisfies Record<SkipReason, "retryable" | "non_retryable">;

/**
 * The retryable subset of {@link SkipReason}, DERIVED from
 * {@link SKIP_REASON_CLASS} so the two cannot drift apart.
 */
export type RetryableSkipReason = {
  [K in SkipReason]: (typeof SKIP_REASON_CLASS)[K] extends "retryable" ? K : never;
}[SkipReason];

/** Every SkipReason, as a value — for validating a receiver-supplied reason string. */
export const SKIP_REASONS: ReadonlySet<SkipReason> = new Set(
  Object.keys(SKIP_REASON_CLASS) as SkipReason[],
);

/** The retryable SkipReasons, as a value. */
export const RETRYABLE_SKIP_REASONS: ReadonlySet<RetryableSkipReason> = new Set(
  (Object.keys(SKIP_REASON_CLASS) as SkipReason[]).filter(
    (reason) => SKIP_REASON_CLASS[reason] === "retryable",
  ) as RetryableSkipReason[],
);

/** Is `value` one of the closed SkipReason strings? */
export function isSkipReason(value: unknown): value is SkipReason {
  return typeof value === "string" && SKIP_REASONS.has(value as SkipReason);
}

/**
 * Static policy for every table FederationSync will merge.
 *
 * Lives next to SkipReason / SyncRecord so the principal-owning decision is
 * one visible list, not a condition scattered through the apply path.
 * `Federation.ts` types its `tableMap` as `Record<FederationSyncTable, …>`,
 * so adding a federated table without deciding `principalOwning` here is a
 * type error rather than a silent default.
 *
 * Scope the principalId requirement by TABLE, never by field presence.
 * Memory carries agentId / a provenance stamp; Soul, Agent, and
 * Relationship do not, and will legitimately have no principalId.
 */
export const FEDERATION_TABLE_POLICY = {
  Memory: { principalOwning: true },
  Soul: { principalOwning: false },
  Agent: { principalOwning: false },
  Relationship: { principalOwning: false },
  // Flair Relay S1 (flair#1521): the Message envelope's owning principal is the
  // SENDER (`from`), not `agentId` — see PRINCIPAL_OWNER_FIELD below. S1 does
  // not sync Message cross-host (the spoke push list in src/cli.ts is a separate
  // hardcoded set), but the policy + owner-field land now so S2 is not a schema
  // or policy migration (the design's ship-order, flair#1521 §12).
  Message: { principalOwning: true },
  // flair#2578 slice 1: Presence replication (spoke → hub, hub-receiver only).
  // Presence carries `agentId` (the row's primary key), no `principalId`, so it
  // is not principal-owning; its receive-side authority is P1's home binding to
  // the batch-verified sender. Registered here so the receive tableMap can carry
  // it; the sender ships in a later slice.
  Presence: { principalOwning: false },
} as const;

export type FederationSyncTable = keyof typeof FEDERATION_TABLE_POLICY;

/**
 * Per-table owning-principal field. `checkPrincipalEntitlement` used to hardcode
 * the owner as `data.agentId` (correct for Memory, the only principal-owning
 * table then). Message owns by `from`, so the owner field is now a per-table
 * map rather than a literal. Tables absent here fall back to `agentId` — only
 * principal-owning tables ever reach the check, and Memory keeps its field.
 */
export const PRINCIPAL_OWNER_FIELD: Record<string, string> = {
  Memory: "agentId",
  Message: "from",
};

/** The owning-principal field for a table (default `agentId`). */
export function principalOwnerField(table: string): string {
  return PRINCIPAL_OWNER_FIELD[table] ?? "agentId";
}

export const FEDERATION_SYNC_TABLES = Object.keys(
  FEDERATION_TABLE_POLICY,
) as FederationSyncTable[];

export const PRINCIPAL_OWNING_TABLES: ReadonlySet<string> = new Set(
  FEDERATION_SYNC_TABLES.filter((t) => FEDERATION_TABLE_POLICY[t].principalOwning),
);

/** Wire `v` when present; assume 1 when absent (today's records omit it). */
export function recordSignatureVersion(record: { v?: number }): number {
  return record.v ?? 1;
}

/**
 * Rebuild the object FederationSync verifies against the originator's key.
 *
 * Load-bearing details, both of which fail every existing record if missed:
 *
 * 1. `v` is not on the wire today. The push side signs a body containing
 *    `v: 1` but sends a SyncRecord without it. Verification works today
 *    only because the receiver pinned the same literal. Default it.
 *    Apply `v` AFTER the spread so an absent/undefined `record.v` cannot
 *    overwrite the default.
 *
 * 2. `principalId` IS on the wire today for some records, but it is
 *    attached AFTER signing (informational). Spreading it into a v:1
 *    verify body changes the field set and fails those records. v:1
 *    therefore strips it; v:2 signs it, so it stays.
 *
 * `originatorInstanceId` is the classifyRecord originator (same override
 * the pre-3a hardcoded reconstruction used), not a blind spread of the
 * wire field.
 */
export function reconstructRecordVerifyBody(
  record: SyncRecord,
  originator: string,
): Record<string, any> {
  const v = recordSignatureVersion(record);
  const { signature, v: _wireV, principalId, ...payload } = record;
  const verifyPayload =
    v >= 2 && principalId !== undefined ? { ...payload, principalId } : payload;
  return {
    ...verifyPayload,
    v,
    originatorInstanceId: originator,
    signature,
  };
}

/**
 * Per-record principal entitlement — apply-site check, DB-free.
 *
 * Table in PRINCIPAL_OWNING_TABLES → principalId is mandatory on v:2
 * (absent is a skip, mismatched is a skip). Table not in the set →
 * principalId is not consulted at all.
 *
 * Does not load Agent, does not read originatorInstanceId off an Agent
 * row. The record's own stamp is the binding.
 *
 * `enforceV1Principal` is Phase 3 (FLAIR_FEDERATION_REQUIRE_RECORD_PRINCIPAL):
 * skip leftover v:1 records on principal-owning tables that lack
 * principalId. Off by default — v:1 Memory keeps merging until an
 * operator flips the flag after the fleet is on v:2.
 */
export function checkPrincipalEntitlement(
  record: SyncRecord,
  opts: { enforceV1Principal?: boolean } = {},
): SkipReason | null {
  if (!PRINCIPAL_OWNING_TABLES.has(record.table)) {
    return null;
  }
  const ownerField = principalOwnerField(record.table);
  const v = recordSignatureVersion(record);
  if (v >= 2) {
    if (
      typeof record.principalId !== "string" ||
      record.principalId.length === 0 ||
      record.principalId !== record.data?.[ownerField]
    ) {
      return "principal_mismatch";
    }
    return null;
  }
  if (
    opts.enforceV1Principal &&
    (typeof record.principalId !== "string" || record.principalId.length === 0)
  ) {
    return "principal_mismatch";
  }
  return null;
}

export type ClassifyResult =
  | { action: "merge"; originator: string }
  | { action: "skip"; reason: SkipReason };

/** The Memory attributes that would carry a pointer into an inbound federated
 *  row (flair#1940 A1' item 5). Local + pure — this module stays DB-free. */
const FEDERATION_POINTER_FIELDS = ["hostSource", "hostSourceScope", "hostSourceVisibility"] as const;

function inboundCarriesPointer(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  return FEDERATION_POINTER_FIELDS.some((f) => (data as Record<string, unknown>)[f] !== undefined);
}

export function classifyRecord(
  record: SyncRecord,
  peerRole: string,
  receiverInstanceId: string,
  local: Record<string, any> | null,
  knownTables: Set<string>,
  now: Date = new Date(),
): ClassifyResult {
  if (!knownTables.has(record.table)) {
    return { action: "skip", reason: "unknown_table" };
  }

  // flair#1940 A1' item 5: refuse an inbound row carrying a host pointer.
  if (inboundCarriesPointer(record.data)) {
    return { action: "skip", reason: "pointer_not_federated" };
  }

  const originator = record.originatorInstanceId ?? receiverInstanceId;
  if (originator !== receiverInstanceId && peerRole !== "hub") {
    return { action: "skip", reason: "non_originator" };
  }

  const fiveMinFromNow = new Date(now.getTime() + 5 * 60 * 1000).toISOString();
  if (record.updatedAt > fiveMinFromNow) {
    return { action: "skip", reason: "future_timestamp" };
  }

  const remoteContentHash = (record.data as any)?.contentHash;
  if (
    local &&
    local.contentHash &&
    remoteContentHash &&
    local.contentHash === remoteContentHash &&
    record.updatedAt <= (local.updatedAt ?? "")
  ) {
    return { action: "skip", reason: "no_op_same_hash" };
  }

  return { action: "merge", originator };
}

/**
 * flair#2108: does this inbound Agent record's effective status differ from an
 * existing local principal's effective stored status (a record with no `status`
 * field counts as "active")? True only when the record is for
 * the Agent table, a local row exists, and the two differ under the feature's
 * lifecycle rule, which `effectiveAgentStatus` (resources/agent-status-guard.ts)
 * applies to both sides: a missing or undefined `status` is "active".
 * `updatedAt` is not compared, so a record older than the stored row, which
 * would lose the last-write-wins merge, is also true. The federation path
 * carries no verified administrator authority for the principal (the batch is
 * signed, and a record signature may also be present; neither is an admin
 * claim), so a true answer skips the whole record before the raw put.
 */
export function inboundChangesExistingPrincipalStatus(
  record: SyncRecord,
  local: Record<string, any> | null,
): boolean {
  if (record.table !== "Agent" || local == null) return false;
  const data = record.data;
  if (!data || typeof data !== "object") return false;
  return effectiveAgentStatus(data.status) !== effectiveAgentStatus(local.status);
}

/** The stored `publicKey` value of an Agent row seeded but not yet registered. */
export const PENDING_PUBLIC_KEY = "pending";

/**
 * flair#2266: true for an inbound Agent record carrying a `publicKey` different
 * from an existing local row's stored `pending`, regardless of timestamps.
 */
export function inboundChangesExistingPendingKey(
  record: SyncRecord,
  local: Record<string, any> | null,
): boolean {
  if (record.table !== "Agent" || local == null) return false;
  if (local.publicKey !== PENDING_PUBLIC_KEY) return false;
  const data = record.data;
  if (!data || typeof data !== "object") return false;
  return Object.prototype.hasOwnProperty.call(data, "publicKey") && (data as any).publicKey !== local.publicKey;
}
