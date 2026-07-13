/**
 * migrations-space.test.ts — resources/migrations/space.ts's pre-flight
 * space check (ladder step 1): headroom floor (never project past ~90%
 * used), fits-vs-doesn't-fit, and the FLAIR_MIGRATION_TEST_FREE_BYTES test
 * override used by the halt-on-blocked-space INTEGRATION test (see
 * test/integration/migrations-halt-space.test.ts) to force this
 * deterministically against a real spawned Harper without needing an
 * actually-full disk.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { checkSpace, TEST_FREE_BYTES_ENV, type SpaceProbe } from "../../resources/migrations/space.ts";

afterEach(() => {
  delete process.env[TEST_FREE_BYTES_ENV];
});

function probe(freeBytes: number, totalBytes: number): SpaceProbe {
  return { getFreeBytes: () => freeBytes, getTotalBytes: () => totalBytes };
}

describe("checkSpace — fits vs doesn't fit", () => {
  it("ok when needed bytes comfortably fit under the headroom floor", () => {
    const result = checkSpace(
      { dataDir: "/tmp/x", estimatedSnapshotBytes: 1000, estimatedWorkingSetBytes: 1000, headroomFloor: 0.9 },
      probe(9_000_000, 10_000_000), // 90% free (10% used), needs 2000 bytes — trivially under the floor
    );
    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("not ok when needed bytes exceed free bytes outright", () => {
    const result = checkSpace(
      { dataDir: "/tmp/x", estimatedSnapshotBytes: 5000, estimatedWorkingSetBytes: 5000, headroomFloor: 0.9 },
      probe(1000, 10_000), // only 1000 free, needs 10000
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("need");
    expect(result.reason).toContain("have");
  });

  it("not ok when it WOULD fit in raw free bytes but would exceed the 90% headroom floor", () => {
    // total=10000, currently used=8800 (88%), free=1200. Needing 300 bytes
    // technically fits in the 1200 free, but pushes used to 9100/10000 =
    // 91% — over the 90% floor — must be refused (never fill past ~90%).
    const result = checkSpace(
      { dataDir: "/tmp/x", estimatedSnapshotBytes: 300, estimatedWorkingSetBytes: 0, headroomFloor: 0.9 },
      probe(1200, 10_000),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("headroom floor");
  });

  it("exactly at the headroom floor is ok (floor is inclusive)", () => {
    // total=10000, used=8900, free=1100, need=100 -> projected used=9000 = exactly 90%.
    const result = checkSpace(
      { dataDir: "/tmp/x", estimatedSnapshotBytes: 100, estimatedWorkingSetBytes: 0, headroomFloor: 0.9 },
      probe(1100, 10_000),
    );
    expect(result.ok).toBe(true);
  });

  it("defaults headroomFloor to 90% when not specified", () => {
    const result = checkSpace(
      { dataDir: "/tmp/x", estimatedSnapshotBytes: 5000, estimatedWorkingSetBytes: 0 },
      probe(1000, 10_000), // needs 5000, only 1000 free — fails on raw fit regardless of floor
    );
    expect(result.ok).toBe(false);
  });

  it("reports freeBytes/totalBytes/neededBytes/projectedUsedFraction accurately", () => {
    const result = checkSpace(
      { dataDir: "/tmp/x", estimatedSnapshotBytes: 200, estimatedWorkingSetBytes: 300, headroomFloor: 0.9 },
      probe(1000, 10_000),
    );
    expect(result.freeBytes).toBe(1000);
    expect(result.totalBytes).toBe(10_000);
    expect(result.neededBytes).toBe(500);
    expect(result.projectedUsedFraction).toBeCloseTo((9000 + 500) / 10_000, 5);
  });
});

describe("checkSpace — test-only free-bytes env override (space.ts's realGetFreeBytes)", () => {
  it("the default probe honors FLAIR_MIGRATION_TEST_FREE_BYTES when set", () => {
    process.env[TEST_FREE_BYTES_ENV] = "1024";
    // Use the REAL default probe (no injected probe) against a real path —
    // the override should short-circuit before any real statfs call, so
    // any existing directory works as `dataDir`.
    const { defaultSpaceProbe } = require("../../resources/migrations/space.ts");
    expect(defaultSpaceProbe.getFreeBytes("/tmp")).toBe(1024);
  });

  it("an invalid override value is ignored, falling back to the real statfs result", () => {
    process.env[TEST_FREE_BYTES_ENV] = "not-a-number";
    const { defaultSpaceProbe } = require("../../resources/migrations/space.ts");
    const real = defaultSpaceProbe.getFreeBytes("/tmp");
    expect(typeof real).toBe("number");
    expect(real).toBeGreaterThanOrEqual(0);
  });
});
