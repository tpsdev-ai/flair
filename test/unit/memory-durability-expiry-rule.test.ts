/**
 * memory-durability-expiry-rule.test.ts — flair#2274.
 *
 * `stampEphemeralExpiry` is the ONE shared rule used to give an ephemeral row
 * its tier expiry (durability -> expiresAt). It lives in
 * resources/memory-durability.ts, which has zero imports, so this is a pure
 * unit test of the rule itself: the write paths' behavior rides on it, and the
 * real-Harper control lives in
 * test/integration/feed-ephemeral-expiry-e2e.test.ts.
 *
 * The rule (see its doc comment): effective durability is the write's own
 * `durability`, else the stored row's; a caller-supplied expiresAt is never
 * overwritten; a pre-existing row's expiresAt is carried forward, never
 * re-stamped; otherwise the tier default is now + FLAIR_EPHEMERAL_TTL_HOURS
 * (default 24).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { stampEphemeralExpiry } from "../../resources/memory-durability.ts";

const ORIGINAL_TTL = process.env.FLAIR_EPHEMERAL_TTL_HOURS;

beforeEach(() => {
  process.env.FLAIR_EPHEMERAL_TTL_HOURS = "6";
});
afterEach(() => {
  if (ORIGINAL_TTL === undefined) delete process.env.FLAIR_EPHEMERAL_TTL_HOURS;
  else process.env.FLAIR_EPHEMERAL_TTL_HOURS = ORIGINAL_TTL;
});

describe("stampEphemeralExpiry — the shared tier expiry rule", () => {
  it("stamps now + the configured TTL on an ephemeral row with no expiry", () => {
    const before = Date.now();
    const row: Record<string, any> = { durability: "ephemeral" };
    stampEphemeralExpiry(row);
    const expiry = Date.parse(row.expiresAt);
    expect(Number.isNaN(expiry)).toBe(false);
    // 6h TTL, small slack for the clock read inside the rule.
    expect(expiry).toBeGreaterThanOrEqual(before + 6 * 3600_000 - 60_000);
    expect(expiry).toBeLessThanOrEqual(Date.now() + 6 * 3600_000 + 60_000);
  });

  it("reads FLAIR_EPHEMERAL_TTL_HOURS at call time (a different value moves the result)", () => {
    process.env.FLAIR_EPHEMERAL_TTL_HOURS = "1";
    const row: Record<string, any> = { durability: "ephemeral" };
    stampEphemeralExpiry(row);
    const ttlMs = Date.parse(row.expiresAt) - Date.now();
    expect(ttlMs).toBeGreaterThan(0);
    expect(ttlMs).toBeLessThanOrEqual(3600_000 + 60_000);
  });

  it("never overwrites a caller-supplied expiresAt", () => {
    const supplied = new Date(Date.now() + 123_456_789).toISOString();
    const row: Record<string, any> = { durability: "ephemeral", expiresAt: supplied };
    stampEphemeralExpiry(row);
    expect(row.expiresAt).toBe(supplied);
  });

  it("leaves a non-ephemeral row with no expiry (no over-fire)", () => {
    for (const durability of ["permanent", "persistent", "standard", undefined]) {
      const row: Record<string, any> = durability === undefined ? {} : { durability };
      stampEphemeralExpiry(row);
      expect(row.expiresAt, `durability=${durability}`).toBeUndefined();
    }
  });

  it("takes the effective durability from the stored row when the write omits it", () => {
    const row: Record<string, any> = {}; // a partial PUT body, no durability
    stampEphemeralExpiry(row, { durability: "ephemeral" });
    expect(typeof row.expiresAt).toBe("string");

    const other: Record<string, any> = {};
    stampEphemeralExpiry(other, { durability: "persistent" });
    expect(other.expiresAt).toBeUndefined();
  });

  it("carries a pre-existing expiry forward instead of re-stamping it", () => {
    const stored = new Date(Date.now() + 9_000_000).toISOString();
    const row: Record<string, any> = { durability: "ephemeral" };
    stampEphemeralExpiry(row, { durability: "ephemeral", expiresAt: stored });
    expect(row.expiresAt).toBe(stored);
  });
});
