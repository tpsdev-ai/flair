/**
 * presence-federation-2578.test.ts — flair#2578 slice 1: the PURE Presence
 * federation rules (resources/presence-receipt.ts) and the policy/retry-class
 * wiring they depend on (resources/federation-classify.ts).
 *
 * No Harper: the receive path itself is exercised against a real Harper in
 * test/integration/federation-presence-receive-2578.test.ts; this file pins the
 * decision rules those guarantees rest on.
 */
import { describe, expect, it } from "bun:test";
import {
  mergePresenceReceipt,
  presenceHomeBindingReason,
  presenceReceiveEnabled,
  presenceWriteHomeRefusal,
  validatePresenceReceipt,
  PRESENCE_CURRENT_TASK_MAX_LENGTH,
  PRESENCE_RECEIVE_FLAG_ENV,
} from "../../resources/presence-receipt.js";
import {
  FEDERATION_TABLE_POLICY,
  PRINCIPAL_OWNING_TABLES,
  RETRYABLE_SKIP_REASONS,
  SKIP_REASON_CLASS,
} from "../../resources/federation-classify.js";

const NOW = 1_000_000_000_000;

/** A minimal valid inbound Presence row (wire shape: id + agentId + the fields). */
function wireRow(over: Record<string, unknown> = {}, agentId = "agent-a"): Record<string, any> {
  return {
    id: agentId,
    agentId,
    lastHeartbeatAt: NOW - 1_000,
    activity: "coding",
    activityUpdatedAt: NOW - 1_000,
    currentTask: "reviewing x",
    flairVersion: "0.61.0",
    harperVersion: "5.3.1",
    originatorInstanceId: "spoke-a",
    ...over,
  };
}

// ─── P7 / the flag ───────────────────────────────────────────────────────────

describe("presenceReceiveEnabled (P7)", () => {
  it("is OFF by default and for any non-truthy value", () => {
    expect(presenceReceiveEnabled({})).toBe(false);
    expect(presenceReceiveEnabled({ [PRESENCE_RECEIVE_FLAG_ENV]: "" })).toBe(false);
    expect(presenceReceiveEnabled({ [PRESENCE_RECEIVE_FLAG_ENV]: "false" })).toBe(false);
    expect(presenceReceiveEnabled({ [PRESENCE_RECEIVE_FLAG_ENV]: "0" })).toBe(false);
    expect(presenceReceiveEnabled({ [PRESENCE_RECEIVE_FLAG_ENV]: "nope" })).toBe(false);
  });
  it("is ON for the repo-wide boolean vocabulary", () => {
    for (const v of ["1", "true", "TRUE", "yes", "on", " on "]) {
      expect(presenceReceiveEnabled({ [PRESENCE_RECEIVE_FLAG_ENV]: v }), v).toBe(true);
    }
  });
});

describe("the Presence policy + retry classes (P7)", () => {
  it("Presence is a known, non-principal-owning table", () => {
    expect(FEDERATION_TABLE_POLICY.Presence.principalOwning).toBe(false);
    expect(PRINCIPAL_OWNING_TABLES.has("Presence")).toBe(false);
  });

  it("every new Presence reason has its class, and the retryable one is only the not-replicated skip", () => {
    expect(SKIP_REASON_CLASS.presence_receive_disabled).toBe("non_retryable");
    expect(SKIP_REASON_CLASS.presence_agent_not_replicated).toBe("retryable");
    expect(SKIP_REASON_CLASS.presence_agent_homed_elsewhere).toBe("non_retryable");
    expect(SKIP_REASON_CLASS.presence_stale_heartbeat).toBe("non_retryable");
    expect(SKIP_REASON_CLASS.presence_invalid_shape).toBe("non_retryable");
    expect(SKIP_REASON_CLASS.presence_future_timestamp).toBe("non_retryable");
    expect(RETRYABLE_SKIP_REASONS.has("presence_agent_not_replicated" as any)).toBe(true);
    expect(RETRYABLE_SKIP_REASONS.has("presence_agent_homed_elsewhere" as any)).toBe(false);
  });
});

// ─── P1: home binding (pure) ─────────────────────────────────────────────────

describe("presenceHomeBindingReason (P1)", () => {
  it("a not-yet-replicated Agent row is retryable", () => {
    expect(presenceHomeBindingReason(null, "spoke-a")).toBe("presence_agent_not_replicated");
  });
  it("a null-home or other-home Agent row is non-retryable", () => {
    expect(presenceHomeBindingReason({ originatorInstanceId: null }, "spoke-a")).toBe("presence_agent_homed_elsewhere");
    expect(presenceHomeBindingReason({}, "spoke-a")).toBe("presence_agent_homed_elsewhere");
    expect(presenceHomeBindingReason({ originatorInstanceId: "" }, "spoke-a")).toBe("presence_agent_homed_elsewhere");
    expect(presenceHomeBindingReason({ originatorInstanceId: "spoke-b" }, "spoke-a")).toBe("presence_agent_homed_elsewhere");
  });
  it("accepts only when the Agent's home IS the sender", () => {
    expect(presenceHomeBindingReason({ originatorInstanceId: "spoke-a" }, "spoke-a")).toBeNull();
  });
});

// ─── P5: receipt validation ──────────────────────────────────────────────────

describe("validatePresenceReceipt (P5)", () => {
  it("accepts a valid row and strips it to the declared fields", () => {
    const res = validatePresenceReceipt("agent-a", wireRow({ hostSource: "/nope", extra: 1 }), NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.row).toEqual({
      agentId: "agent-a",
      lastHeartbeatAt: NOW - 1_000,
      currentTask: "reviewing x",
      activity: "coding",
      activityUpdatedAt: NOW - 1_000,
      flairVersion: "0.61.0",
      harperVersion: "5.3.1",
      originatorInstanceId: "spoke-a",
      receivedAt: NOW,
    });
  });

  it("rejects a row whose agentId disagrees with the record id, and a missing/absent agentId", () => {
    expect(validatePresenceReceipt("agent-a", wireRow({}, "agent-b"), NOW)).toEqual({ ok: false, reason: "presence_invalid_shape" });
    expect(validatePresenceReceipt("agent-a", { id: "agent-a", lastHeartbeatAt: NOW }, NOW)).toEqual({ ok: false, reason: "presence_invalid_shape" });
    expect(validatePresenceReceipt("agent-a", null, NOW)).toEqual({ ok: false, reason: "presence_invalid_shape" });
  });

  it("rejects a missing or non-finite lastHeartbeatAt", () => {
    expect(validatePresenceReceipt("agent-a", wireRow({ lastHeartbeatAt: null }), NOW)).toEqual({ ok: false, reason: "presence_invalid_shape" });
    expect(validatePresenceReceipt("agent-a", wireRow({ lastHeartbeatAt: "1" }), NOW)).toEqual({ ok: false, reason: "presence_invalid_shape" });
    expect(validatePresenceReceipt("agent-a", wireRow({ lastHeartbeatAt: Number.NaN }), NOW)).toEqual({ ok: false, reason: "presence_invalid_shape" });
    expect(validatePresenceReceipt("agent-a", wireRow({ lastHeartbeatAt: Number.POSITIVE_INFINITY }), NOW)).toEqual({ ok: false, reason: "presence_invalid_shape" });
  });

  it("rejects an activity outside the local vocabulary", () => {
    expect(validatePresenceReceipt("agent-a", wireRow({ activity: "hacking" }), NOW)).toEqual({ ok: false, reason: "presence_invalid_shape" });
    expect(validatePresenceReceipt("agent-a", wireRow({ activity: 7 }), NOW)).toEqual({ ok: false, reason: "presence_invalid_shape" });
  });

  it("leaves an absent activity off the stripped row (so the merge can keep the stored label)", () => {
    const row = wireRow();
    delete row.activity;
    const res = validatePresenceReceipt("agent-a", row, NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect("activity" in res.row).toBe(false);
  });

  it("caps currentTask and drops a non-string task", () => {
    const long = "x".repeat(PRESENCE_CURRENT_TASK_MAX_LENGTH + 50);
    const res = validatePresenceReceipt("agent-a", wireRow({ currentTask: `  ${long}  ` }), NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect((res.row.currentTask as string).length).toBe(PRESENCE_CURRENT_TASK_MAX_LENGTH);
    const other = validatePresenceReceipt("agent-a", wireRow({ currentTask: 42 }), NOW);
    expect(other.ok).toBe(true);
    if (other.ok) expect(other.row.currentTask).toBeNull();
  });

  it("drops an over-long or non-string version, keeps a 64-char one", () => {
    const long = "v".repeat(65);
    const ok64 = "v".repeat(64);
    const res = validatePresenceReceipt("agent-a", wireRow({ flairVersion: long, harperVersion: 5 }), NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.row.flairVersion).toBeNull();
    expect(res.row.harperVersion).toBeNull();
    const res2 = validatePresenceReceipt("agent-a", wireRow({ flairVersion: ok64 }), NOW);
    expect(res2.ok).toBe(true);
    if (res2.ok) expect(res2.row.flairVersion).toBe(ok64);
  });

  it("rejects a non-finite activityUpdatedAt", () => {
    expect(validatePresenceReceipt("agent-a", wireRow({ activityUpdatedAt: "x" }), NOW)).toEqual({ ok: false, reason: "presence_invalid_shape" });
  });

  it("rejects a stamp beyond the receiver's clock plus the 5-minute allowance", () => {
    const future = NOW + 5 * 60 * 1000 + 1;
    expect(validatePresenceReceipt("agent-a", wireRow({ lastHeartbeatAt: future }), NOW)).toEqual({ ok: false, reason: "presence_future_timestamp" });
    expect(validatePresenceReceipt("agent-a", wireRow({ activityUpdatedAt: future }), NOW)).toEqual({ ok: false, reason: "presence_future_timestamp" });
    // exactly at the bound is accepted
    const atBound = NOW + 5 * 60 * 1000;
    expect(validatePresenceReceipt("agent-a", wireRow({ lastHeartbeatAt: atBound }), NOW).ok).toBe(true);
  });
});

// ─── P4: the merge ───────────────────────────────────────────────────────────

describe("mergePresenceReceipt (P4)", () => {
  const incoming = () => {
    const v = validatePresenceReceipt("agent-a", wireRow(), NOW);
    if (!v.ok) throw new Error("fixture invalid");
    return v.row;
  };

  it("accepts a row with no stored counterpart", () => {
    const res = mergePresenceReceipt(null, incoming(), NOW);
    expect(res.action).toBe("merge");
    if (res.action !== "merge") return;
    expect(res.row.agentId).toBe("agent-a");
    expect(res.row.receivedAt).toBe(NOW);
  });

  it("skips an older heartbeat by name", () => {
    const local = { agentId: "agent-a", lastHeartbeatAt: NOW - 1 };
    const res = mergePresenceReceipt(local, incoming(), NOW);
    expect(res).toEqual({ action: "skip", reason: "presence_stale_heartbeat" });
  });

  it("accepts a newer heartbeat", () => {
    const local = { agentId: "agent-a", lastHeartbeatAt: NOW - 100_000, activityUpdatedAt: NOW - 100_000 };
    const res = mergePresenceReceipt(local, incoming(), NOW);
    expect(res.action).toBe("merge");
  });

  it("ties on the heartbeat are broken by activityUpdatedAt", () => {
    const hb = NOW - 1_000;
    const older = { agentId: "agent-a", lastHeartbeatAt: hb, activityUpdatedAt: NOW - 500 };
    expect(mergePresenceReceipt(older, incoming(), NOW)).toEqual({ action: "skip", reason: "presence_stale_heartbeat" });
    const equal = { agentId: "agent-a", lastHeartbeatAt: hb, activityUpdatedAt: hb };
    expect(mergePresenceReceipt(equal, incoming(), NOW).action).toBe("merge");
  });

  it("a TIED heartbeat with an ABSENT incoming activity stamp keeps the stored activity/task", () => {
    // The exact blanking input: equal heartbeat, stored activity/task/stamp,
    // incoming null stamp and null/other task. A null stamp is not STRICTLY
    // newer, so the stored activity fields stand — the tie cannot blank them.
    const hb = NOW - 1_000;
    const local = { agentId: "agent-a", lastHeartbeatAt: hb, activity: "coding", currentTask: "stored task", activityUpdatedAt: NOW - 500 };
    const inc = { ...incoming(), activity: "idle", currentTask: null, activityUpdatedAt: null } as any;
    const res = mergePresenceReceipt(local, inc, NOW);
    expect(res.action).toBe("merge");
    if (res.action !== "merge") return;
    expect(res.row.currentTask).toBe("stored task");
    expect(res.row.activity).toBe("coding");
    expect(res.row.activityUpdatedAt).toBe(NOW - 500);
    expect(res.row.lastHeartbeatAt).toBe(hb);
  });

  it("never LOWERS the stored activityUpdatedAt (mixed clock skew)", () => {
    // The inbound heartbeat is newer, but its activity stamp is OLDER than stored.
    const local = { agentId: "agent-a", lastHeartbeatAt: NOW - 5_000, activityUpdatedAt: NOW - 10 };
    const inc = { ...incoming(), activityUpdatedAt: NOW - 900 };
    const res = mergePresenceReceipt(local, inc, NOW);
    expect(res.action).toBe("merge");
    if (res.action !== "merge") return;
    expect(res.row.activityUpdatedAt).toBe(NOW - 10);
    expect(res.row.lastHeartbeatAt).toBe(NOW - 1_000);
  });

  it("falls back to the stored activity when the inbound row carries none", () => {
    const local = { agentId: "agent-a", lastHeartbeatAt: NOW - 5_000, activity: "planning", activityUpdatedAt: NOW - 5_000 };
    const inc = { ...incoming() };
    delete (inc as any).activity;
    const res = mergePresenceReceipt(local, inc, NOW);
    expect(res.action).toBe("merge");
    if (res.action === "merge") expect(res.row.activity).toBe("planning");
  });

  it("defaults to idle when neither side carries an activity", () => {
    const inc = { agentId: "agent-a", lastHeartbeatAt: NOW - 1_000, currentTask: null, activityUpdatedAt: null };
    const res = mergePresenceReceipt(null, inc, NOW);
    expect(res.action).toBe("merge");
    if (res.action === "merge") expect(res.row.activity).toBe("idle");
  });
});

// ─── P2: the local-write home refusal (pure) ─────────────────────────────────

describe("presenceWriteHomeRefusal (P2)", () => {
  it("treats a null (or absent) home as LOCAL", () => {
    expect(presenceWriteHomeRefusal({ originatorInstanceId: null }, "local-1")).toBeNull();
    expect(presenceWriteHomeRefusal({}, "local-1")).toBeNull();
    expect(presenceWriteHomeRefusal({ originatorInstanceId: "" }, "local-1")).toBeNull();
    expect(presenceWriteHomeRefusal(null, "local-1")).toBeNull();
  });
  it("allows a home equal to this instance", () => {
    expect(presenceWriteHomeRefusal({ originatorInstanceId: "local-1" }, "local-1")).toBeNull();
  });
  it("refuses a home that is another instance", () => {
    expect(presenceWriteHomeRefusal({ originatorInstanceId: "other" }, "local-1")?.error).toBe("presence_agent_homed_elsewhere");
  });
  it("refuses any non-null home when this instance has no identity", () => {
    expect(presenceWriteHomeRefusal({ originatorInstanceId: "other" }, null)?.error).toBe("presence_agent_homed_elsewhere");
    expect(presenceWriteHomeRefusal({ originatorInstanceId: null }, null)).toBeNull();
  });
});
