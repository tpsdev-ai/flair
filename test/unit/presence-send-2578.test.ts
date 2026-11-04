/**
 * presence-send-2578.test.ts — flair#2578 slice 2, the pure sender rules.
 *
 * The sender has no Harper import, so the flag, the cursor, the watermark parse
 * and the home/watermark selection are unit-testable here. The end-to-end push
 * (a real sender against a real receiver) is in
 * test/integration/federation-presence-send-2578.test.ts; the mocked-fetch push
 * is test/unit/federation-sync-push-presence-2578.test.ts.
 */
import { describe, expect, it } from "bun:test";
import {
  PRESENCE_SEND_FLAG_ENV,
  PRESENCE_SEND_FUTURE_ALLOWANCE_MS,
  PRESENCE_SEND_RECEIVE_DISABLED_SKIP_REASON,
  PRESENCE_SEND_RETRYABLE_SKIP_REASONS,
  presenceCursorMs,
  presenceSendEnabled,
  presenceWatermarkMs,
  presenceWireRecord,
  selectPresenceRowsToSend,
} from "../../src/federation/presence-send.js";
// Test-only imports: src/ cannot import resources/ (packaging), so the two
// sender-side mirrors are pinned to the receiver's own definitions here.
import { PRESENCE_FUTURE_ALLOWANCE_MS, validatePresenceReceipt } from "../../resources/presence-receipt.js";
import { SKIP_REASON_CLASS } from "../../resources/federation-classify.js";

const ME = "flair_spoke_a";

describe("presence-send — flag", () => {
  it("default OFF and only 1/true/yes/on are ON", () => {
    expect(presenceSendEnabled({})).toBe(false);
    expect(presenceSendEnabled({ [PRESENCE_SEND_FLAG_ENV]: "" })).toBe(false);
    expect(presenceSendEnabled({ [PRESENCE_SEND_FLAG_ENV]: "0" })).toBe(false);
    expect(presenceSendEnabled({ [PRESENCE_SEND_FLAG_ENV]: "false" })).toBe(false);
    expect(presenceSendEnabled({ [PRESENCE_SEND_FLAG_ENV]: "nonsense" })).toBe(false);
    for (const on of ["1", "true", "TRUE", "yes", "on", " On "]) {
      expect(presenceSendEnabled({ [PRESENCE_SEND_FLAG_ENV]: on })).toBe(true);
    }
  });
});

describe("presence-send — cursor", () => {
  it("is the later of lastHeartbeatAt and activityUpdatedAt", () => {
    expect(presenceCursorMs({ lastHeartbeatAt: 1000, activityUpdatedAt: 2000 })).toBe(2000);
    expect(presenceCursorMs({ lastHeartbeatAt: 3000, activityUpdatedAt: 2000 })).toBe(3000);
  });

  it("tolerates a BigInt column read back as a bigint or a numeric string", () => {
    expect(presenceCursorMs({ lastHeartbeatAt: 1234n })).toBe(1234);
    expect(presenceCursorMs({ lastHeartbeatAt: "1234" })).toBe(1234);
  });

  it("falls back to whichever stamp is present, and is null when neither is finite", () => {
    expect(presenceCursorMs({ lastHeartbeatAt: null, activityUpdatedAt: 500 })).toBe(500);
    expect(presenceCursorMs({ lastHeartbeatAt: 500, activityUpdatedAt: null })).toBe(500);
    expect(presenceCursorMs({ lastHeartbeatAt: null, activityUpdatedAt: null })).toBeNull();
    expect(presenceCursorMs({ lastHeartbeatAt: "not-a-number" })).toBeNull();
    expect(presenceCursorMs({})).toBeNull();
  });
});

describe("presence-send — watermark", () => {
  it("parses an ISO stamp to ms, and treats absent/unparseable as 0 (select eligible rows with positive cursors)", () => {
    const iso = "2026-01-02T03:04:05.000Z";
    expect(presenceWatermarkMs(iso)).toBe(Date.parse(iso));
    expect(presenceWatermarkMs(undefined)).toBe(0);
    expect(presenceWatermarkMs("")).toBe(0);
    expect(presenceWatermarkMs("garbage")).toBe(0);
  });
});

describe("presence-send — selection", () => {
  const home = (agentId: string, heartbeat: number, activityUpdatedAt: number | null = null) => ({
    agentId,
    lastHeartbeatAt: heartbeat,
    activityUpdatedAt,
    originatorInstanceId: ME,
  });

  it("keeps only home rows whose cursor is past the supplied floor", () => {
    const rows = [
      home("a", 5000),
      home("b", 1000),
      { agentId: "c", lastHeartbeatAt: 9000, originatorInstanceId: "flair_other" },
      { agentId: "d", lastHeartbeatAt: 9000 },
    ];
    const selected = selectPresenceRowsToSend(rows, ME, 2000);
    expect(selected.map((r) => r.agentId)).toEqual(["a"]);
  });

  it("a row whose activityUpdatedAt (not heartbeat) advanced is selected", () => {
    const rows = [home("a", 1000, 5000)];
    expect(selectPresenceRowsToSend(rows, ME, 2000).map((r) => r.agentId)).toEqual(["a"]);
  });

  it("a row exactly at the floor is NOT re-sent", () => {
    expect(selectPresenceRowsToSend([home("a", 2000)], ME, 2000)).toEqual([]);
  });

  it("a row with no cursor is never selected", () => {
    const rows = [{ agentId: "a", originatorInstanceId: ME }];
    expect(selectPresenceRowsToSend(rows, ME, 0)).toEqual([]);
  });
});

describe("presence-send — wire record", () => {
  it("skips cursors outside the Date range", () => {
    for (const stamp of [10n ** 16n, Number.MAX_VALUE]) {
      for (const field of ["lastHeartbeatAt", "activityUpdatedAt"]) {
        const row = { agentId: "agent-a", originatorInstanceId: ME, lastHeartbeatAt: 1000, [field]: stamp };
        expect(presenceWireRecord(row, ME)).toBeNull();
        expect(presenceCursorMs(row)).toBeNull();
        expect(selectPresenceRowsToSend([row], ME, 0)).toEqual([]);
      }
    }
  });

  for (const stamp of ["1234", 1234n]) {
    it(`normalizes ${typeof stamp} timestamps for the receiver validator`, () => {
      const record = presenceWireRecord({
        agentId: "agent-a",
        lastHeartbeatAt: stamp,
        activityUpdatedAt: stamp,
        receivedAt: stamp,
      }, ME)!;
      expect(record.data.lastHeartbeatAt).toBe(1234);
      expect(record.data.activityUpdatedAt).toBe(1234);
      expect(record.data.receivedAt).toBe(1234);
      expect(validatePresenceReceipt(record.id, JSON.parse(JSON.stringify(record.data)), 1234, ME).ok).toBe(true);
    });
  }

  it("rejects an unusable timestamp even when another stamp supplies a cursor", () => {
    for (const field of ["lastHeartbeatAt", "activityUpdatedAt", "receivedAt"]) {
      for (const value of ["invalid", Infinity, 10n ** 400n]) {
        expect(presenceWireRecord({
          agentId: "agent-a", lastHeartbeatAt: 1000, activityUpdatedAt: 2000, [field]: value,
        }, ME)).toBeNull();
      }
    }
    expect(presenceWireRecord({ agentId: "agent-a", activityUpdatedAt: 2000 }, ME)).toBeNull();
  });

  it("keys on agentId: id, data.id and data.agentId all agree, and updatedAt is the cursor", () => {
    const cursor = Date.parse("2026-01-02T03:04:05.000Z");
    const record = presenceWireRecord(
      { agentId: "agent-a", lastHeartbeatAt: cursor, activity: "coding", originatorInstanceId: ME },
      ME,
    )!;
    expect(record.table).toBe("Presence");
    expect(record.v).toBe(2);
    expect(record.id).toBe("agent-a");
    expect(record.data.id).toBe("agent-a");
    expect(record.data.agentId).toBe("agent-a");
    expect(record.updatedAt).toBe("2026-01-02T03:04:05.000Z");
    expect(record.originatorInstanceId).toBe(ME);
  });

  it("is null without a usable agentId or cursor", () => {
    expect(presenceWireRecord({ lastHeartbeatAt: 1, originatorInstanceId: ME }, ME)).toBeNull();
    expect(presenceWireRecord({ agentId: "a", originatorInstanceId: ME }, ME)).toBeNull();
  });
});

describe("presence-send — sender mirrors of receiver rules", () => {
  it("the send-side future allowance equals the receiver's", () => {
    expect(PRESENCE_SEND_FUTURE_ALLOWANCE_MS).toBe(PRESENCE_FUTURE_ALLOWANCE_MS);
  });

  it("the retryable skip-reason set equals the receiver's retryable subset", () => {
    const receiverRetryable = Object.entries(SKIP_REASON_CLASS)
      .filter(([, cls]) => cls === "retryable")
      .map(([reason]) => reason)
      .sort();
    expect([...PRESENCE_SEND_RETRYABLE_SKIP_REASONS].sort()).toEqual(receiverRetryable);
  });

  it("the receive-disabled skip reason is the receiver's non_retryable reason of that name", () => {
    expect(SKIP_REASON_CLASS[PRESENCE_SEND_RECEIVE_DISABLED_SKIP_REASON as keyof typeof SKIP_REASON_CLASS]).toBe("non_retryable");
    expect(PRESENCE_SEND_RETRYABLE_SKIP_REASONS.has(PRESENCE_SEND_RECEIVE_DISABLED_SKIP_REASON)).toBe(false);
  });
});
