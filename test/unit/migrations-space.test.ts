/**
 * migrations-space.test.ts — resources/migrations/space.ts's pre-flight
 * space check (ladder step 1).
 *
 * flair#720 replaced the original rule (fits AND projectedUsedFraction <=
 * 90% of TOTAL disk size) with an absolute-reserve rule: fits AND
 * (freeBytes - neededBytes) >= reserve, where reserve = clamp(5% of total,
 * 256 MiB, 2 GiB) or FLAIR_MIGRATION_RESERVE_BYTES when set. The old
 * fraction-of-total test punished a disk's PRE-EXISTING fullness (a
 * normally >90%-used personal Mac halted a 220 KB migration with 18.6 GB
 * free) instead of judging the migration's own impact — every test below
 * that used to assert the fraction-of-total behavior has been rewritten to
 * the new rule, not deleted, so this file stays the historical record of
 * what's actually enforced.
 *
 * Also covers the FLAIR_MIGRATION_TEST_FREE_BYTES test override used by the
 * halt-on-blocked-space INTEGRATION test (see
 * test/integration/migrations-halt-space.test.ts) to force this
 * deterministically against a real spawned Harper without needing an
 * actually-full disk.
 */
import { describe, it, expect, afterEach } from "bun:test";
import {
  checkSpace,
  resolveReserveBytes,
  humanBytes,
  RESERVE_MIN_BYTES,
  RESERVE_MAX_BYTES,
  RESERVE_FRACTION,
  RESERVE_BYTES_ENV,
  TEST_FREE_BYTES_ENV,
  type SpaceProbe,
} from "../../resources/migrations/space.ts";

const KiB = 1024;
const MiB = 1024 * KiB;
const GiB = 1024 * MiB;

afterEach(() => {
  delete process.env[TEST_FREE_BYTES_ENV];
  delete process.env[RESERVE_BYTES_ENV];
});

function probe(freeBytes: number, totalBytes: number): SpaceProbe {
  return { getFreeBytes: () => freeBytes, getTotalBytes: () => totalBytes };
}

describe("checkSpace — flair#720 acid tests (verbatim from the issue)", () => {
  it("18.6 GB free / 220 KB needed on a normally-full personal disk PASSES (the flair#720 bug report)", () => {
    // The exact numbers from the bug report: need 225280 bytes (220 KB),
    // have 18655997952 bytes (~17.4 GiB / ~18.66 GB) free. Disk is a
    // typical ~500 GiB personal Mac SSD sitting at >96% used — under the
    // OLD fraction-of-total rule this halted every time despite the
    // migration's own footprint being trivial. Reserve caps at 2 GiB
    // (5% of 500 GiB is way over the cap), and 18.6 GB free leaves far
    // more than 2 GiB after spending 220 KB, so this now passes.
    const totalBytes = 500 * GiB;
    const freeBytes = 18_655_997_952;
    const neededBytes = 225_280; // 220 KiB
    const result = checkSpace(
      { dataDir: "/tmp/x", estimatedSnapshotBytes: neededBytes, estimatedWorkingSetBytes: 0 },
      probe(freeBytes, totalBytes),
    );
    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(result.reserveBytes).toBe(RESERVE_MAX_BYTES);
  });

  it("500 MB free / 400 MB needed FAILS — technically fits, but doesn't clear the reserve", () => {
    const freeBytes = 500 * MiB;
    const neededBytes = 400 * MiB;
    const result = checkSpace(
      { dataDir: "/tmp/x", estimatedSnapshotBytes: neededBytes, estimatedWorkingSetBytes: 0 },
      probe(freeBytes, 500 * GiB), // total large enough the reserve is capped at 2 GiB either way
    );
    expect(neededBytes).toBeLessThanOrEqual(freeBytes); // sanity: this is the "technically fits" case, not a raw-fit failure
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("short of the");
    expect(result.reason).toContain("2.00 GB minimum reserve");
  });

  it("big re-embed working set on a near-full disk FAILS — fits raw, but leaves only 1 GiB against a 2 GiB reserve", () => {
    const totalBytes = 500 * GiB;
    const freeBytes = 30 * GiB;
    const neededBytes = 29 * GiB; // huge working set, disk is at ~94% used before the migration even runs
    const result = checkSpace(
      { dataDir: "/tmp/x", estimatedSnapshotBytes: 8192, estimatedWorkingSetBytes: neededBytes - 8192 },
      probe(freeBytes, totalBytes),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("short of the");
  });
});

describe("checkSpace — fits vs doesn't fit (rewritten for flair#720's absolute-reserve rule)", () => {
  it("ok when needed bytes comfortably fit with room to spare beyond the reserve", () => {
    // flair#720: previously asserted "90% free (10% used) trivially under
    // the [fraction] floor" — rewritten to the reserve rule. total=10 GiB
    // gives reserve = 5% of 10 GiB = 512 MiB (between the 256 MiB floor and
    // the 2 GiB cap, so the fraction itself applies). free=9 GiB, needed=
    // 2000 bytes — remaining after is ~9 GiB, comfortably over the 512 MiB
    // reserve.
    const result = checkSpace(
      { dataDir: "/tmp/x", estimatedSnapshotBytes: 1000, estimatedWorkingSetBytes: 1000 },
      probe(9 * GiB, 10 * GiB),
    );
    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("not ok when needed bytes exceed free bytes outright (raw-fit failure, independent of the reserve)", () => {
    const result = checkSpace(
      { dataDir: "/tmp/x", estimatedSnapshotBytes: 5000, estimatedWorkingSetBytes: 5000 },
      probe(1000, 10_000), // only 1000 free, needs 10000
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("need");
    expect(result.reason).toContain("have");
    expect(result.reason).toContain("short by");
  });

  it("flair#720: a disk already >90% used (pre-existing fullness) no longer matters on its own — only the migration's own impact vs the reserve does", () => {
    // Old rule: total=10000, used=8800 (88%), free=1200; needing 300 bytes
    // pushed used to 9100/10000 = 91% and was REFUSED purely because of
    // the disk's pre-existing fullness. New rule only cares whether
    // (freeBytes - neededBytes) clears the reserve — with a small total
    // like this the reserve floors at 256 MiB, which 1200 free bytes can
    // never clear regardless of how little is needed, so this specific
    // tiny-disk example still fails today — but for the RIGHT reason (the
    // absolute reserve on a near-empty disk), not because 91% > 90%.
    const result = checkSpace(
      { dataDir: "/tmp/x", estimatedSnapshotBytes: 300, estimatedWorkingSetBytes: 0 },
      probe(1200, 10_000),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("minimum reserve");
    expect(result.reason).not.toContain("headroom floor"); // the old wording is gone
  });

  it("a migration that fits AND clears a realistic reserve is ok even when the disk is already >90% used in total — flair#720's core fix", () => {
    // This is the shape of the actual bug: disk is 96%+ used in total
    // terms, but the reserve is an absolute cushion capped at 2 GiB, not a
    // fraction of the (mostly irrelevant) total.
    const totalBytes = 200 * GiB;
    const freeBytes = 5 * GiB; // 97.5% used already
    const result = checkSpace(
      { dataDir: "/tmp/x", estimatedSnapshotBytes: 1 * MiB, estimatedWorkingSetBytes: 0 },
      probe(freeBytes, totalBytes),
    );
    expect(result.ok).toBe(true);
  });

  it("reports freeBytes/totalBytes/neededBytes/reserveBytes accurately", () => {
    const result = checkSpace(
      { dataDir: "/tmp/x", estimatedSnapshotBytes: 200, estimatedWorkingSetBytes: 300 },
      probe(1000, 10_000),
    );
    expect(result.freeBytes).toBe(1000);
    expect(result.totalBytes).toBe(10_000);
    expect(result.neededBytes).toBe(500);
    expect(result.reserveBytes).toBe(RESERVE_MIN_BYTES); // 5% of 10_000 is nowhere near the 256 MiB floor
  });
});

describe("resolveReserveBytes — clamping at both ends + the mid-range 5% branch", () => {
  it("tiny disk: 5% of total is below the 256 MiB floor, so the floor wins", () => {
    const totalBytes = 1 * GiB; // 5% = ~51.2 MiB, well under RESERVE_MIN_BYTES
    expect(resolveReserveBytes(totalBytes, {})).toBe(RESERVE_MIN_BYTES);
  });

  it("mid-size disk: 5% of total lands between the floor and the cap, so the fraction itself is used", () => {
    const totalBytes = 20 * GiB; // 5% = 1 GiB, between 256 MiB and 2 GiB
    const expected = totalBytes * RESERVE_FRACTION;
    expect(expected).toBeGreaterThan(RESERVE_MIN_BYTES);
    expect(expected).toBeLessThan(RESERVE_MAX_BYTES);
    expect(resolveReserveBytes(totalBytes, {})).toBe(expected);
  });

  it("huge disk: 5% of total exceeds the 2 GiB cap, so the cap wins", () => {
    const totalBytes = 1024 * GiB; // 1 TiB; 5% = ~51.2 GiB, way over RESERVE_MAX_BYTES
    expect(resolveReserveBytes(totalBytes, {})).toBe(RESERVE_MAX_BYTES);
  });
});

describe("checkSpace / resolveReserveBytes — FLAIR_MIGRATION_RESERVE_BYTES env override", () => {
  it("a valid override replaces the computed reserve entirely, including on a disk where the computed reserve would otherwise be the 2 GiB cap", () => {
    const totalBytes = 500 * GiB; // would otherwise cap at RESERVE_MAX_BYTES
    expect(resolveReserveBytes(totalBytes, { [RESERVE_BYTES_ENV]: "12345" })).toBe(12345);
  });

  it("0 is a valid override — disables the reserve check entirely, leaving only the raw-fit test", () => {
    const result = checkSpace(
      { dataDir: "/tmp/x", estimatedSnapshotBytes: 999, estimatedWorkingSetBytes: 0 },
      probe(1000, 500 * GiB),
    );
    process.env[RESERVE_BYTES_ENV] = "0";
    const overridden = checkSpace(
      { dataDir: "/tmp/x", estimatedSnapshotBytes: 999, estimatedWorkingSetBytes: 0 },
      probe(1000, 500 * GiB),
    );
    expect(result.ok).toBe(false); // without the override, the 2 GiB default reserve fails against 1 free byte remaining
    expect(overridden.ok).toBe(true); // with reserve=0, 999 <= 1000 is all that's required
    expect(overridden.reserveBytes).toBe(0);
  });

  it("an invalid override (non-numeric) is ignored, falling back to the computed reserve", () => {
    expect(resolveReserveBytes(20 * GiB, { [RESERVE_BYTES_ENV]: "not-a-number" })).toBe(20 * GiB * RESERVE_FRACTION);
  });

  it("an invalid override (negative) is ignored, falling back to the computed reserve", () => {
    expect(resolveReserveBytes(1 * GiB, { [RESERVE_BYTES_ENV]: "-1" })).toBe(RESERVE_MIN_BYTES);
  });

  it("an invalid override (Infinity / NaN) is ignored, falling back to the computed reserve", () => {
    expect(resolveReserveBytes(1 * GiB, { [RESERVE_BYTES_ENV]: "Infinity" })).toBe(RESERVE_MIN_BYTES);
    expect(resolveReserveBytes(1 * GiB, { [RESERVE_BYTES_ENV]: "NaN" })).toBe(RESERVE_MIN_BYTES);
  });

  it("checkSpace honors the env override end-to-end and mentions it in the failure reason", () => {
    process.env[RESERVE_BYTES_ENV] = String(10 * GiB); // deliberately huge, forces a failure
    const result = checkSpace(
      { dataDir: "/tmp/x", estimatedSnapshotBytes: 1000, estimatedWorkingSetBytes: 0 },
      probe(9 * GiB, 500 * GiB),
    );
    expect(result.ok).toBe(false);
    expect(result.reserveBytes).toBe(10 * GiB);
    expect(result.reason).toContain(RESERVE_BYTES_ENV);
  });
});

describe("checkSpace — failure reason is truthful and actionable (flair#720)", () => {
  it("does NOT suggest pruning snapshots or FLAIR_SNAPSHOT_DIR — that advice can't help on a system volume", () => {
    const result = checkSpace(
      { dataDir: "/tmp/x", estimatedSnapshotBytes: 400 * MiB, estimatedWorkingSetBytes: 0 },
      probe(500 * MiB, 500 * GiB),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).not.toContain("prune");
    expect(result.reason).not.toContain("FLAIR_SNAPSHOT_DIR");
  });

  it("names the env override as the actionable remedy for constrained deployments", () => {
    const result = checkSpace(
      { dataDir: "/tmp/x", estimatedSnapshotBytes: 400 * MiB, estimatedWorkingSetBytes: 0 },
      probe(500 * MiB, 500 * GiB),
    );
    expect(result.reason).toContain(RESERVE_BYTES_ENV);
  });

  it("renders every byte quantity in the reason as human-readable, never raw byte counts", () => {
    const result = checkSpace(
      { dataDir: "/tmp/x", estimatedSnapshotBytes: 400 * MiB, estimatedWorkingSetBytes: 0 },
      probe(500 * MiB, 500 * GiB),
    );
    expect(result.reason).toContain("400.0 MB");
    expect(result.reason).toContain("500.0 MB");
    expect(result.reason).toContain("2.00 GB");
    // The raw byte counts must not leak into the human-facing string.
    expect(result.reason).not.toContain(String(400 * MiB));
    expect(result.reason).not.toContain(String(500 * MiB));
  });

  it("the outright-doesn't-fit reason is phrased as a shortfall, not a confusing negative remainder", () => {
    const result = checkSpace(
      { dataDir: "/tmp/x", estimatedSnapshotBytes: 10_000, estimatedWorkingSetBytes: 0 },
      probe(1000, 10_000),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("short by 8.8 KB");
  });
});

describe("humanBytes — formatting", () => {
  it("formats bytes under 1 KiB with the raw B unit", () => {
    expect(humanBytes(0)).toBe("0 B");
    expect(humanBytes(1023)).toBe("1023 B");
  });

  it("formats the KB boundary and range with one decimal", () => {
    expect(humanBytes(1024)).toBe("1.0 KB");
    expect(humanBytes(225_280)).toBe("220.0 KB"); // the flair#720 bug report's exact "needed" value
  });

  it("formats the MB boundary and range with one decimal", () => {
    expect(humanBytes(1024 * 1024)).toBe("1.0 MB");
    expect(humanBytes(400 * MiB)).toBe("400.0 MB");
  });

  it("formats the GB boundary and range with two decimals", () => {
    expect(humanBytes(1024 * 1024 * 1024)).toBe("1.00 GB");
    expect(humanBytes(18_655_997_952)).toBe("17.37 GB"); // the flair#720 bug report's exact "have" value
  });

  it("returns an em dash for negative or non-finite input", () => {
    expect(humanBytes(-1)).toBe("—");
    expect(humanBytes(NaN)).toBe("—");
    expect(humanBytes(Infinity)).toBe("—");
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
