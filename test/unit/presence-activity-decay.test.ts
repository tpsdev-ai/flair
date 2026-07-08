/**
 * presence-activity-decay.test.ts — Unit tests for the natural-presence
 * activity-decay logic: is a record's activity/currentTask still CURRENT, or
 * has it lapsed into last-known?
 *
 * These tests exercise INLINE COPIES of activityFreshnessAt()/isActivityFresh()
 * from resources/Presence.ts — same technique (and same reason) as
 * presence-status-derivation.test.ts / presence-version-record.test.ts:
 * resources/Presence.ts extends `databases.flair.Presence` at module load,
 * which throws outside a running Harper. Live coverage of the decay applied to
 * a real GET /Presence lives in test/integration/presence-api.test.ts.
 */

import { describe, test, expect } from "bun:test";

// ─── Inline copies (mirror resources/Presence.ts) ──────────────────────────────

const OFFLINE_THRESHOLD = 600_000; // 600s — the same boundary as presenceStatus offline

function activityFreshnessAt(
  activityUpdatedAt: number | null | undefined,
  lastHeartbeatAt: number | null | undefined,
): number | null {
  if (typeof activityUpdatedAt === "number" && Number.isFinite(activityUpdatedAt)) return activityUpdatedAt;
  if (typeof lastHeartbeatAt === "number" && Number.isFinite(lastHeartbeatAt)) return lastHeartbeatAt;
  return null;
}

function isActivityFresh(
  now: number,
  activityUpdatedAt: number | null | undefined,
  lastHeartbeatAt: number | null | undefined,
  offlineMs: number = OFFLINE_THRESHOLD,
): boolean {
  const at = activityFreshnessAt(activityUpdatedAt, lastHeartbeatAt);
  if (at == null) return false;
  const elapsed = now - at;
  if (elapsed < 0) return true;
  return elapsed < offlineMs;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;

describe("activityFreshnessAt", () => {
  test("prefers activityUpdatedAt when it is a finite number", () => {
    expect(activityFreshnessAt(NOW - 1000, NOW - 999999)).toBe(NOW - 1000);
  });

  test("falls back to lastHeartbeatAt when activityUpdatedAt is null (old record)", () => {
    expect(activityFreshnessAt(null, NOW - 5000)).toBe(NOW - 5000);
  });

  test("falls back to lastHeartbeatAt when activityUpdatedAt is undefined", () => {
    expect(activityFreshnessAt(undefined, NOW - 5000)).toBe(NOW - 5000);
  });

  test("falls back to lastHeartbeatAt when activityUpdatedAt is NaN", () => {
    expect(activityFreshnessAt(NaN, NOW - 5000)).toBe(NOW - 5000);
  });

  test("falls back to lastHeartbeatAt when activityUpdatedAt is Infinity", () => {
    expect(activityFreshnessAt(Infinity, NOW - 5000)).toBe(NOW - 5000);
  });

  test("null when NEITHER is a finite number", () => {
    expect(activityFreshnessAt(null, null)).toBeNull();
    expect(activityFreshnessAt(undefined, undefined)).toBeNull();
    expect(activityFreshnessAt(NaN, NaN)).toBeNull();
  });
});

describe("isActivityFresh", () => {
  describe("fresh: stamp younger than the offline threshold", () => {
    test("just-stamped (0ms elapsed) → fresh", () => {
      expect(isActivityFresh(NOW, NOW, NOW)).toBe(true);
    });

    test("30s old → fresh", () => {
      expect(isActivityFresh(NOW, NOW - 30_000, NOW - 30_000)).toBe(true);
    });

    test("1ms before the offline boundary → fresh", () => {
      expect(isActivityFresh(NOW, NOW - (OFFLINE_THRESHOLD - 1), NOW)).toBe(true);
    });

    test("idle-window heartbeat (5min old) → activity still fresh", () => {
      // Matches derivePresenceStatus semantics: an idle (not offline) agent's
      // activity is plausibly still current; only crossing offline decays it.
      expect(isActivityFresh(NOW, NOW - 300_000, NOW - 300_000)).toBe(true);
    });
  });

  describe("stale: stamp at or past the offline threshold", () => {
    test("exactly at the offline threshold → stale (mirrors presenceStatus offline boundary)", () => {
      expect(isActivityFresh(NOW, NOW - OFFLINE_THRESHOLD, NOW - OFFLINE_THRESHOLD)).toBe(false);
    });

    test("1ms past the offline threshold → stale", () => {
      expect(isActivityFresh(NOW, NOW - OFFLINE_THRESHOLD - 1, NOW)).toBe(false);
    });

    test("13 days old (the real-world frozen-'debugging' case) → stale", () => {
      const thirteenDays = 13 * 24 * 60 * 60 * 1000;
      expect(isActivityFresh(NOW, NOW - thirteenDays, NOW - thirteenDays)).toBe(false);
    });
  });

  describe("independent decay: activity older than liveness", () => {
    test("fresh heartbeat but activity stamp past the threshold → activity stale", () => {
      // Agent keeps heartbeating liveness (lastHeartbeatAt fresh) but stopped
      // asserting activity 11min ago → activity decays even though it's online.
      expect(isActivityFresh(NOW, NOW - 660_000, NOW - 1_000)).toBe(false);
    });

    test("fresh activity stamp but stale heartbeat → activity still fresh (stamp wins)", () => {
      expect(isActivityFresh(NOW, NOW - 1_000, NOW - 660_000)).toBe(true);
    });
  });

  describe("old records (no activityUpdatedAt): fall back to lastHeartbeatAt", () => {
    test("fresh heartbeat, no stamp → fresh (as fresh as the beat)", () => {
      expect(isActivityFresh(NOW, null, NOW - 1_000)).toBe(true);
    });

    test("stale heartbeat, no stamp → stale (never fresher than the beat)", () => {
      expect(isActivityFresh(NOW, undefined, NOW - 700_000)).toBe(false);
    });

    test("no stamp AND no heartbeat → stale (nothing to judge)", () => {
      expect(isActivityFresh(NOW, null, null)).toBe(false);
    });
  });

  describe("clock skew", () => {
    test("stamp in the future (negative elapsed) → fresh, matching derivePresenceStatus", () => {
      expect(isActivityFresh(NOW, NOW + 5_000, NOW + 5_000)).toBe(true);
    });
  });

  describe("custom threshold", () => {
    test("respects a custom offline threshold", () => {
      expect(isActivityFresh(NOW, NOW - 31_000, NOW, 30_000)).toBe(false);
      expect(isActivityFresh(NOW, NOW - 29_000, NOW, 30_000)).toBe(true);
    });
  });
});
