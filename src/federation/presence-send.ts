/**
 * presence-send.ts — the sender-side selection rules for Presence replication
 * (flair#2578 slice 2: office-wide Presence). PURE: no Harper import, so every
 * rule here is unit-testable without a live Harper.
 *
 * The CLI scans the local Presence table (bounded at one row per agent) and
 * passes the rows here. The Presence table has no `updatedAt`/`createdAt`, so the
 * generic sync cursor cannot select it: a row is selected by its OWN cursor —
 * the later of `lastHeartbeatAt` and `activityUpdatedAt` — compared against a
 * per-table watermark the sender stores. Only rows stamped with this instance as
 * their originator are sent.
 *
 * Sender-side support for spoke-to-hub Presence replication, behind its own
 * default-off flag. The receiver side (slice 1) is resources/presence-receipt.
 */

/** The wire shape the sender builds (a subset of the receive-side SyncRecord;
 *  src/ cannot import resources/, so the fields this module needs are local). */
export interface PresenceWireRecord {
  v: number;
  table: "Presence";
  id: string;
  data: Record<string, any>;
  updatedAt: string;
  originatorInstanceId: string;
}

/** The send flag (default OFF). */
export const PRESENCE_SEND_FLAG_ENV = "FLAIR_FEDERATION_PRESENCE_SEND";

/** Truthy: `1` / `true` / `yes` / `on`. Anything else — unset, empty, `false`,
 *  `0`, garbage — is OFF, so the default sends no Presence records. Same
 *  vocabulary as the receive flag (resources/presence-receipt). */
export function presenceSendEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = (env[PRESENCE_SEND_FLAG_ENV] ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/** Normalize a Presence timestamp column to a finite unix-ms number.
 *  A row read from Harper may hand a BigInt back as a bigint or a numeric
 *  string, not a JS number. */
function toMs(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * The Presence row's own cursor: the later of `lastHeartbeatAt` and
 * `activityUpdatedAt`, as unix ms. Null when neither is a finite timestamp — a
 * row with no cursor cannot be placed against a watermark and is never sent.
 */
export function presenceCursorMs(row: Record<string, any>): number | null {
  const heartbeat = toMs(row?.lastHeartbeatAt);
  const activity = toMs(row?.activityUpdatedAt);
  if (heartbeat == null) return activity;
  if (activity == null) return heartbeat;
  return Math.max(heartbeat, activity);
}

/** The stored per-table watermark (an ISO string) as unix ms, or 0 when it is
 *  absent or unparseable — 0 selects every home row, which is the intended
 *  first-sync behaviour. */
export function presenceWatermarkMs(value: unknown): number {
  if (typeof value !== "string" || value.trim() === "") return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * The rows this instance may send: HOME rows (originatorInstanceId is this
 * instance — slice 1 stamps it on a local create) whose own cursor advanced
 * past the watermark. A replicated row, a row with no stamp, a row with no
 * cursor, and a row at or below the watermark are all excluded.
 */
export function selectPresenceRowsToSend(
  rows: readonly Record<string, any>[],
  instanceId: string,
  watermarkMs: number,
): Record<string, any>[] {
  const selected: Record<string, any>[] = [];
  for (const row of rows) {
    if (row?.originatorInstanceId !== instanceId) continue;
    const cursor = presenceCursorMs(row);
    if (cursor == null || cursor <= watermarkMs) continue;
    selected.push(row);
  }
  return selected;
}

/**
 * The unsigned wire record for one Presence row. This table keys on `agentId`,
 * so the record's `id` and `data.id` are the row's `agentId` (the shared batch
 * key check wants `data.id === record.id`) and `data.agentId` carries the same
 * value. `updatedAt` is the row's own cursor, so the receiver's future-timestamp
 * bound and the classifyRecord staleness check see a real time. Null when the
 * row has no usable `agentId` or cursor.
 */
export function presenceWireRecord(
  row: Record<string, any>,
  instanceId: string,
): PresenceWireRecord | null {
  const agentId = typeof row?.agentId === "string" && row.agentId.length > 0 ? row.agentId : null;
  const cursor = presenceCursorMs(row);
  if (!agentId || cursor == null) return null;
  return {
    v: 2,
    table: "Presence",
    id: agentId,
    data: { ...row, id: agentId, agentId },
    updatedAt: new Date(cursor).toISOString(),
    originatorInstanceId: instanceId,
  };
}
