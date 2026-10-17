/**
 * presence-receipt.ts — the federation receive-side rules for Presence, and the
 * local-write home guard (flair#2578 slice 1: office-wide Presence).
 *
 * PURE: no Harper import, so every rule here is unit-testable without a live
 * Harper. The callers read the local Agent row and the stored Presence row and
 * pass them in; resources/Federation.ts runs the receive path, and
 * resources/Presence.ts runs the local write paths (POST, PUT, PATCH).
 *
 * This module also owns the Presence activity vocabulary and the currentTask
 * cap, because the receipt validator accepts the same activity vocabulary and
 * currentTask cap a POST heartbeat applies — one definition, so the two cannot
 * drift.
 *
 * Receive-side support for planned spoke-to-hub Presence replication; the sender
 * follows in a later slice. It ships
 * behind ONE default-off receive flag; with the flag off a Presence record that
 * reaches the receive branch is skipped by its own name
 * (`presence_receive_disabled`), not `unknown_table`.
 *
 * The sender contract (a later slice): a Presence record's wire `id` and its
 * `data.id` will be the row's `agentId` (this table's primary key),
 * `data.agentId` will carry that same value, the record's
 * `originatorInstanceId` will be the sending instance, and only rows whose
 * `originatorInstanceId` is the sender will be sent.
 */

import type { SkipReason } from "./federation-classify.js";

// ─── Flag ────────────────────────────────────────────────────────────────────

/** The receive flag (default OFF). */
export const PRESENCE_RECEIVE_FLAG_ENV = "FLAIR_FEDERATION_PRESENCE_RECEIVE";

/** Truthy: `1` / `true` / `yes` / `on`. Anything else — unset, empty, `false`,
 *  `0`, garbage — is OFF, so the default is no Presence replication. */
export function presenceReceiveEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = (env[PRESENCE_RECEIVE_FLAG_ENV] ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

// ─── Vocabulary + caps (shared with resources/Presence.ts) ────────────────────

/** The local activity vocabulary; a replicated row's `activity` must be a
 *  member. Same set a POST heartbeat accepts (resources/Presence.ts). */
export const PRESENCE_ACTIVITIES: ReadonlySet<string> = new Set([
  "coding",
  "reviewing",
  "planning",
  "debugging",
  "idle",
]);

/** The currentTask cap; a replicated `currentTask` goes through the same cap as
 *  a POST heartbeat. */
export const PRESENCE_CURRENT_TASK_MAX_LENGTH = 200;

/** Trim + cap a currentTask, or null for absent/empty — the POST heartbeat's
 *  rule, applied to a replicated row. */
export function sanitizePresenceCurrentTask(task: unknown): string | null {
  if (typeof task !== "string") return null;
  const trimmed = task.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, PRESENCE_CURRENT_TASK_MAX_LENGTH);
}

// ─── Bounds ──────────────────────────────────────────────────────────────────

/** The allowance the receiver grants an inbound heartbeat stamp ahead of its
 *  own clock — the same 5 minutes classifyRecord applies to a wire `updatedAt`. */
export const PRESENCE_FUTURE_ALLOWANCE_MS = 5 * 60 * 1000;

/** The cap on `flairVersion` / `harperVersion`; a longer value is dropped. */
export const PRESENCE_VERSION_MAX_LENGTH = 64;

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A stored Presence stamp read back from Harper: the schema column is BigInt,
 *  so a row read from the table may hand back a bigint (or a numeric string),
 *  not a JS number. Normalize it to a finite number, or null. NOT used on
 *  inbound wire data — that is a JSON number and is checked strictly. */
function presenceMs(value: unknown): number | null {
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

function presenceVersion(value: unknown): string | null {
  return typeof value === "string" && value.length <= PRESENCE_VERSION_MAX_LENGTH ? value : null;
}

// ─── P1: home binding on receipt ─────────────────────────────────────────────

/**
 * Is the local Agent row for a replicated Presence record homed on the
 * batch-verified SENDER? The sender is the only home authority — never the wire
 * `originatorInstanceId` (which a sender self-asserts).
 *
 *   - the Agent row is absent locally → `presence_agent_not_replicated`
 *     (retryable: it may replicate later);
 *   - the Agent row's home is another instance, or null →
 *     `presence_agent_homed_elsewhere` (non-retryable);
 *   - the home is the sender → null (accept).
 */
export function presenceHomeBindingReason(
  agentRow: Record<string, any> | null,
  senderInstanceId: string,
): SkipReason | null {
  if (agentRow == null) return "presence_agent_not_replicated";
  const home = agentRow.originatorInstanceId;
  if (typeof home !== "string" || home.length === 0 || home !== senderInstanceId) {
    return "presence_agent_homed_elsewhere";
  }
  return null;
}

// ─── P5: receipt validation ──────────────────────────────────────────────────

/**
 * Strip an inbound Presence row to the declared Presence fields and validate
 * it. Returns the stripped row, or a named skip reason. A row that fails is
 * never stored, so one bad peer row cannot reach a reader.
 *
 * `recordId` is the wire record's id, which for this table IS the primary key
 * (`agentId`); the inbound `data.agentId` must agree with it, so the row that
 * is validated is the row that is written.
 */
export function validatePresenceReceipt(
  recordId: string,
  data: unknown,
  receivedAt: number,
): { ok: true; row: Record<string, unknown> } | { ok: false; reason: SkipReason } {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, reason: "presence_invalid_shape" };
  }
  const d = data as Record<string, unknown>;
  const agentId = typeof d.agentId === "string" ? d.agentId : null;
  if (!agentId || agentId !== recordId) return { ok: false, reason: "presence_invalid_shape" };

  const lastHeartbeatAt = finiteNumber(d.lastHeartbeatAt);
  if (lastHeartbeatAt == null) return { ok: false, reason: "presence_invalid_shape" };
  if (lastHeartbeatAt > receivedAt + PRESENCE_FUTURE_ALLOWANCE_MS) {
    return { ok: false, reason: "presence_future_timestamp" };
  }

  if (d.activity !== undefined && d.activity !== null &&
    (typeof d.activity !== "string" || !PRESENCE_ACTIVITIES.has(d.activity))) {
    return { ok: false, reason: "presence_invalid_shape" };
  }

  let activityUpdatedAt: number | null = null;
  if (d.activityUpdatedAt !== undefined && d.activityUpdatedAt !== null) {
    activityUpdatedAt = finiteNumber(d.activityUpdatedAt);
    if (activityUpdatedAt == null) return { ok: false, reason: "presence_invalid_shape" };
    if (activityUpdatedAt > receivedAt + PRESENCE_FUTURE_ALLOWANCE_MS) {
      return { ok: false, reason: "presence_future_timestamp" };
    }
  }

  const row: Record<string, unknown> = {
    agentId,
    lastHeartbeatAt,
    currentTask: sanitizePresenceCurrentTask(d.currentTask),
    activityUpdatedAt,
    flairVersion: presenceVersion(d.flairVersion),
    harperVersion: presenceVersion(d.harperVersion),
    originatorInstanceId: typeof d.originatorInstanceId === "string" ? d.originatorInstanceId : null,
    receivedAt,
  };
  // An absent activity is left off so the merge can fall back to the stored
  // label instead of overwriting it with a hole.
  if (typeof d.activity === "string") row.activity = d.activity;
  return { ok: true, row };
}

// ─── P4: Presence-specific merge ─────────────────────────────────────────────

/**
 * An older `lastHeartbeatAt`, or a tie with both `activityUpdatedAt` stamps
 * present and the incoming stamp older, skips as `presence_stale_heartbeat`.
 * On a heartbeat tie, an equal or absent incoming activity stamp merges while
 * keeping the stored activity fields. An accepted record never lowers the
 * stored `activityUpdatedAt`.
 */
export function mergePresenceReceipt(
  local: Record<string, any> | null,
  incoming: Record<string, unknown>,
  receivedAt: number,
): { action: "merge"; row: Record<string, unknown> } | { action: "skip"; reason: SkipReason } {
  const incHb = incoming.lastHeartbeatAt as number;
  const incAut = presenceMs(incoming.activityUpdatedAt);
  const localHb = local ? presenceMs(local.lastHeartbeatAt) : null;
  const localAut = local ? presenceMs(local.activityUpdatedAt) : null;

  if (localHb != null) {
    if (incHb < localHb) return { action: "skip", reason: "presence_stale_heartbeat" };
    // A tie whose activity ordering is OLDER (both stamps present) is stale.
    // A tie with an absent incoming stamp merges, keeping stored activity fields.
    if (incHb === localHb && localAut != null && incAut != null && incAut < localAut) {
      return { action: "skip", reason: "presence_stale_heartbeat" };
    }
  }

  // On a heartbeat tie, the incoming activity fields replace the stored ones
  // only when the incoming stamp is STRICTLY newer. An equal or absent stamp
  // merges while keeping the stored activity/task/stamp.
  const tied = localHb != null && incHb === localHb;
  const incomingStrictlyNewer = incAut != null && (localAut == null || incAut > localAut);
  const keepStoredActivity = tied && !incomingStrictlyNewer;

  const activityUpdatedAt = keepStoredActivity
    ? localAut
    : incAut == null ? localAut : localAut == null ? incAut : Math.max(incAut, localAut);
  const activity = keepStoredActivity
    ? (typeof local?.activity === "string" ? local.activity : ((incoming.activity as string | undefined) ?? "idle"))
    : ((incoming.activity as string | undefined)
      ?? (typeof local?.activity === "string" ? local.activity : undefined)
      ?? "idle");
  const currentTask = keepStoredActivity ? (local?.currentTask ?? null) : (incoming.currentTask ?? null);

  return {
    action: "merge",
    row: {
      agentId: incoming.agentId,
      lastHeartbeatAt: incHb,
      currentTask,
      activity,
      activityUpdatedAt: activityUpdatedAt ?? null,
      flairVersion: incoming.flairVersion ?? null,
      harperVersion: incoming.harperVersion ?? null,
      originatorInstanceId: incoming.originatorInstanceId ?? null,
      receivedAt,
    },
  };
}

// ─── P2: local-write home refusal ────────────────────────────────────────────

/**
 * A local write for an agent HOMED ON ANOTHER INSTANCE is refused; a null home
 * is treated as LOCAL (so a legacy Agent row created before the originator
 * contract keeps heartbeating). An instance with no identity of its own
 * (`localInstanceId` null) is the home of no agent that has a non-null home.
 *
 * Returns a named refusal, or null to allow the write.
 */
export function presenceWriteHomeRefusal(
  agentRow: Record<string, any> | null | undefined,
  localInstanceId: string | null,
): { error: string; message: string } | null {
  const home = agentRow?.originatorInstanceId;
  if (typeof home !== "string" || home.length === 0) return null;
  if (localInstanceId != null && home === localInstanceId) return null;
  return {
    error: "presence_agent_homed_elsewhere",
    message: "this agent's presence is homed on another instance; write it there",
  };
}
