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

  it("preserves a canonical explicit UTC expiry", () => {
    const supplied = new Date(Date.now() + 123_456_789).toISOString();
    const row: Record<string, any> = { durability: "ephemeral", expiresAt: supplied };
    stampEphemeralExpiry(row);
    expect(row.expiresAt).toBe(supplied);
  });

  it("normalizes explicit UTC timestamps before storing", () => {
    for (const [expiresAt, canonical] of [
      ["2026-10-08T00:00:00Z", "2026-10-08T00:00:00.000Z"],
      ["2026-10-08T00:00:00.1Z", "2026-10-08T00:00:00.100Z"],
      ["2026-10-08T00:00:00.123456Z", "2026-10-08T00:00:00.123Z"],
      ["2026-10-08T00:00Z", "2026-10-08T00:00:00.000Z"],
      ["2026-10-08T24:00:00Z", "2026-10-09T00:00:00.000Z"],
    ]) {
      for (const incoming of [false, true]) {
        const row: Record<string, any> = { durability: "ephemeral", expiresAt };
        expect(stampEphemeralExpiry(row, null, { incoming })).toBeNull();
        expect(row.expiresAt).toBe(canonical);
      }
    }
  });

  it("normalizes +00:00 UTC expiry for explicit, carried and incoming values", () => {
    for (const expiresAt of ["2026-10-08T00:00:00+00:00", "2026-10-08T00:00+00:00", "2026-10-08T00:00:00.123456+00:00"]) {
      const canonical = new Date(expiresAt).toISOString();
      for (const incoming of [false, true]) {
        const row: Record<string, any> = { durability: "ephemeral", expiresAt };
        expect(stampEphemeralExpiry(row, null, { incoming })).toBeNull();
        expect(row.expiresAt).toBe(canonical);
      }
      const carried: Record<string, any> = { content: "updated" };
      expect(stampEphemeralExpiry(carried, { durability: "ephemeral", expiresAt })).toBeNull();
      expect(carried.expiresAt).toBe(canonical);
    }
  });

  it("normalizes expanded UTC years", () => {
    for (const [expiresAt, canonical] of [
      ["+002026-10-08T00:00:00Z", "2026-10-08T00:00:00.000Z"],
      ["-000001-10-08T00:00:00Z", "-000001-10-08T00:00:00.000Z"],
    ]) {
      const row: Record<string, any> = { durability: "ephemeral", expiresAt };
      expect(stampEphemeralExpiry(row)).toBeNull();
      expect(row.expiresAt).toBe(canonical);
    }
  });

  it("refuses offsets other than +00:00, date-only values and malformed explicit expiry", () => {
    for (const expiresAt of ["2026-10-08T00:00:00-00:00", "2026-10-08T01:00:00+01:00", "2026-10-08", "not-a-date", "2026-02-30T00:00:00Z", null]) {
      const row: Record<string, any> = { durability: "ephemeral", expiresAt };
      expect(stampEphemeralExpiry(row)).toBe("expiresAt must be a valid UTC ISO date");
    }
  });

  it("normalizes a carried UTC expiry on a same-tier update", () => {
    const row: Record<string, any> = { content: "updated" };
    expect(stampEphemeralExpiry(row, { durability: "ephemeral", expiresAt: "2026-10-08T00:00:00Z" })).toBeNull();
    expect(row.expiresAt).toBe("2026-10-08T00:00:00.000Z");
  });

  it("refuses unsupported or malformed stored expiry without carrying it", () => {
    for (const expiresAt of ["not-a-date", "2026-10-08T00:00:00-00:00", "2026-10-08", "2026-02-30T00:00:00Z", 123]) {
      const row: Record<string, any> = { content: "updated" };
      expect(stampEphemeralExpiry(row, { durability: "ephemeral", expiresAt })).toBe("expiresAt must be a valid UTC ISO date");
      expect(row.expiresAt).toBeUndefined();
    }
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

  it("carries a canonical stored expiry without re-stamping it", () => {
    const stored = new Date(Date.now() + 9_000_000).toISOString();
    const row: Record<string, any> = { durability: "ephemeral" };
    stampEphemeralExpiry(row, { durability: "ephemeral", expiresAt: stored });
    expect(row.expiresAt).toBe(stored);
  });
});

describe("expiry updates", () => {
  it("carries stored durability and canonical expiry into a partial PUT", () => {
    const expiresAt = new Date(Date.now() + 900000).toISOString();
    const row: Record<string, any> = { content: "updated" };
    stampEphemeralExpiry(row, { durability: "ephemeral", expiresAt });
    expect(row).toEqual({ content: "updated", durability: "ephemeral", expiresAt });
  });

  it("clears an inherited expiry when leaving ephemeral", () => {
    const row: Record<string, any> = { durability: "persistent" };
    stampEphemeralExpiry(row, { durability: "ephemeral", expiresAt: "2020-01-01T00:00:00.000Z" });
    expect(row.expiresAt).toBeNull();
  });

  it("stamps a fresh expiry when entering ephemeral", () => {
    const before = Date.now();
    const row: Record<string, any> = { durability: "ephemeral" };
    stampEphemeralExpiry(row, { durability: "standard", expiresAt: "2020-01-01T00:00:00.000Z" });
    expect(Date.parse(row.expiresAt)).toBeGreaterThanOrEqual(before + 6 * 3600000);
  });

  it("preserves an explicit expiry when leaving ephemeral", () => {
    const expiresAt = new Date(Date.now() + 900000).toISOString();
    const row: Record<string, any> = { durability: "persistent", expiresAt };
    stampEphemeralExpiry(row, { durability: "ephemeral", expiresAt: "2020-01-01T00:00:00.000Z" });
    expect(row.expiresAt).toBe(expiresAt);
  });

  it("lets an explicit same-tier expiry replace the stored expiry", () => {
    const expiresAt = new Date(Date.now() + 900000).toISOString();
    const row: Record<string, any> = { expiresAt };
    stampEphemeralExpiry(row, { durability: "ephemeral", expiresAt: "2020-01-01T00:00:00.000Z" });
    expect(row.expiresAt).toBe(expiresAt);
  });

  it("refuses malformed incoming ephemeral dates", () => {
    for (const expiresAt of ["invalid", "", 123, null, "2026-02-30T00:00:00.000Z"]) {
      const row: Record<string, any> = { durability: "ephemeral", expiresAt };
      expect(stampEphemeralExpiry(row, null, { incoming: true })).toBeTruthy();
    }
  });

  it("refuses incoming dates beyond the receiver's one-year horizon", () => {
    const row: Record<string, any> = { durability: "ephemeral", expiresAt: new Date(Date.now() + 366 * 86400000).toISOString() };
    expect(stampEphemeralExpiry(row, null, { incoming: true })).toBeTruthy();
    const past: Record<string, any> = { durability: "ephemeral", expiresAt: "1969-12-31T23:59:59.999Z" };
    expect(stampEphemeralExpiry(past, null, { incoming: true })).toBeTruthy();
  });

  it("keeps a canonical incoming date within the receiver's bound", () => {
    const expiresAt = new Date(Date.now() + 86400000).toISOString();
    const row: Record<string, any> = { durability: "ephemeral", expiresAt };
    stampEphemeralExpiry(row, { durability: "ephemeral", expiresAt: "2020-01-01T00:00:00.000Z" }, { incoming: true });
    expect(row.expiresAt).toBe(expiresAt);
  });

  it("uses the receiver's clock for a missing incoming expiry", () => {
    const before = Date.now();
    const row: Record<string, any> = { durability: "ephemeral" };
    stampEphemeralExpiry(row, { durability: "ephemeral", expiresAt: "2020-01-01T00:00:00.000Z" }, { incoming: true });
    expect(Date.parse(row.expiresAt)).toBeGreaterThanOrEqual(before + 6 * 3600000);
  });
});
