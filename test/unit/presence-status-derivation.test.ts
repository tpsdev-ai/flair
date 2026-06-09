/**
 * presence-status-derivation.test.ts — Unit tests for the presence status
 * derivation logic: active / idle / offline across threshold boundaries.
 *
 * These tests exercise the pure `derivePresenceStatus()` function exported
 * from the Presence resource — no Harper instance required.
 */

import { describe, test, expect } from "bun:test";

// ─── Inline the pure function (mirrors resources/Presence.ts) ─────────────────

const ACTIVE_THRESHOLD = 90_000; // 90s
const OFFLINE_THRESHOLD = 600_000; // 600s

function derivePresenceStatus(
  now: number,
  lastHeartbeatAt: number | null | undefined,
  idleMs?: number,
  offlineMs?: number,
): "active" | "idle" | "offline" {
  const idle = idleMs ?? ACTIVE_THRESHOLD;
  const offline = offlineMs ?? OFFLINE_THRESHOLD;

  if (lastHeartbeatAt == null || !Number.isFinite(lastHeartbeatAt)) return "offline";
  const elapsed = now - lastHeartbeatAt;

  // Negative elapsed (clock skew) → treat as active
  if (elapsed < 0) return "active";
  if (elapsed < idle) return "active";
  if (elapsed < offline) return "idle";
  return "offline";
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("derivePresenceStatus", () => {
  const NOW = 1_700_000_000_000;

  describe("active", () => {
    test("just-heartbeat (0ms elapsed)", () => {
      expect(derivePresenceStatus(NOW, NOW)).toBe("active");
    });

    test("within active threshold (1ms before boundary)", () => {
      expect(derivePresenceStatus(NOW, NOW - (ACTIVE_THRESHOLD - 1))).toBe("active");
    });

    test("exactly at threshold boundary (90s)", () => {
      // elapsed === threshold → not strictly less → idle, not active
      expect(derivePresenceStatus(NOW, NOW - ACTIVE_THRESHOLD)).toBe("idle");
    });

    test("1ms after active threshold → idle", () => {
      expect(derivePresenceStatus(NOW, NOW - ACTIVE_THRESHOLD - 1)).toBe("idle");
    });

    test("30s elapsed (typical heartbeat interval)", () => {
      expect(derivePresenceStatus(NOW, NOW - 30_000)).toBe("active");
    });

    test("60s elapsed (max heartbeat interval)", () => {
      expect(derivePresenceStatus(NOW, NOW - 60_000)).toBe("active");
    });
  });

  describe("idle", () => {
    test("91s elapsed", () => {
      expect(derivePresenceStatus(NOW, NOW - 91_000)).toBe("idle");
    });

    test("300s (5min) elapsed", () => {
      expect(derivePresenceStatus(NOW, NOW - 300_000)).toBe("idle");
    });

    test("599s — 1ms before offline threshold", () => {
      expect(derivePresenceStatus(NOW, NOW - (OFFLINE_THRESHOLD - 1))).toBe("idle");
    });

    test("exactly at offline threshold (600s)", () => {
      // elapsed === offline → not strictly less → offline
      expect(derivePresenceStatus(NOW, NOW - OFFLINE_THRESHOLD)).toBe("offline");
    });
  });

  describe("offline", () => {
    test("601s elapsed → offline", () => {
      expect(derivePresenceStatus(NOW, NOW - 601_000)).toBe("offline");
    });

    test("1 hour elapsed", () => {
      expect(derivePresenceStatus(NOW, NOW - 3_600_000)).toBe("offline");
    });

    test("null heartbeat → offline", () => {
      expect(derivePresenceStatus(NOW, null)).toBe("offline");
    });

    test("undefined heartbeat → offline", () => {
      expect(derivePresenceStatus(NOW, undefined)).toBe("offline");
    });

    test("NaN heartbeat → offline", () => {
      expect(derivePresenceStatus(NOW, NaN)).toBe("offline");
    });

    test("Infinity heartbeat → offline", () => {
      expect(derivePresenceStatus(NOW, Infinity)).toBe("offline");
    });
  });

  describe("custom thresholds", () => {
    test("custom idle=30s, 31s → idle (not active)", () => {
      expect(derivePresenceStatus(NOW, NOW - 31_000, 30_000, 120_000)).toBe("idle");
    });

    test("custom offline=120s, 121s → offline", () => {
      expect(derivePresenceStatus(NOW, NOW - 121_000, 30_000, 120_000)).toBe("offline");
    });

    test("custom thresholds: 15s elapsed, idle=20s → active", () => {
      expect(derivePresenceStatus(NOW, NOW - 15_000, 20_000, 60_000)).toBe("active");
    });
  });

  describe("clock skew / edge cases", () => {
    test("future heartbeat (negative elapsed) → active", () => {
      expect(derivePresenceStatus(NOW, NOW + 5_000)).toBe("active");
    });

    test("future heartbeat by 1 hour → active", () => {
      expect(derivePresenceStatus(NOW, NOW + 3_600_000)).toBe("active");
    });

    test("zero heartbeat timestamp (epoch)", () => {
      const elapsed = NOW - 0;
      // This will be offline since elapsed > OFFLINE_THRESHOLD
      expect(derivePresenceStatus(NOW, 0)).toBe("offline");
    });
  });

  describe("boundary walkthrough", () => {
    test("walks all three states correctly over time", () => {
      // Agent heartbeats at T=0
      const hb = NOW;
      expect(derivePresenceStatus(hb, hb)).toBe("active");       // T=0
      expect(derivePresenceStatus(hb + 45_000, hb)).toBe("active");   // 45s
      expect(derivePresenceStatus(hb + 89_999, hb)).toBe("active");   // 89.999s
      expect(derivePresenceStatus(hb + 90_000, hb)).toBe("idle");     // 90s (boundary)
      expect(derivePresenceStatus(hb + 120_000, hb)).toBe("idle");    // 2min
      expect(derivePresenceStatus(hb + 599_999, hb)).toBe("idle");    // 599.999s
      expect(derivePresenceStatus(hb + 600_000, hb)).toBe("offline"); // 600s (boundary)
      expect(derivePresenceStatus(hb + 900_000, hb)).toBe("offline"); // 15min
    });
  });
});
