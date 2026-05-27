/**
 * Pure classifier for federation sync records — no Harper imports.
 *
 * Extracted from Federation.ts so the decision can be unit-tested without
 * spinning up Harper's database module. The same SkipReason names are used
 * in SyncLog.skippedReasons so operators can grep for them.
 */

export interface SyncRecord {
  table: string;
  id: string;
  data: Record<string, any>;
  updatedAt: string;
  originatorInstanceId: string;
  signature?: string;
  principalId?: string;
}

export type SkipReason =
  | "unknown_table"
  | "non_originator"
  | "future_timestamp"
  | "no_op_same_hash";

export type ClassifyResult =
  | { action: "merge"; originator: string }
  | { action: "skip"; reason: SkipReason };

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
