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
  // Emitted by FederationSync.post before the raw put, for a record that passed
  // the earlier sync checks: an inbound Agent record
  // whose effective status (a missing `status` counts as "active") differs from
  // an existing local Agent's effective stored status, also when the record is older than the stored row and would
  // lose the last-write-wins merge. The federation path carries no verified
  // administrator authority for that principal, so the whole record is skipped
  // rather than merged without `status`.
  | "agent_status_not_federated"
  // Emitted by FederationSync.post before the row is read: the payload's id is
  // missing or is not the envelope's id, so the record is not applied.
  | "id_mismatch"
  | "invalid_expiry";

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
