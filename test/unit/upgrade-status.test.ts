/**
 * upgrade-status.test.ts — flair#1778 slice 1.
 *
 * The direction-aware classifier that makes "an install ahead of registry
 * latest" a distinct state, plus the renderer that prints it with no arrow and
 * no remedy, plus the never-lower-a-pin guard. These are the pure pieces both
 * `src/cli.ts` and `src/commands/upgrade.ts` now share.
 */
import { describe, test, expect } from "bun:test";
import {
  classifyInstalledVersion,
  formatUpgradeStatusLine,
  upgradeStatusSuffix,
  shouldPrintUpgradeLine,
  comparePinVersions,
  pinWriteWouldLowerOrIsUnknown,
} from "../../src/lib/upgrade-status.ts";
import { resolveFlairMcpFinding } from "../../src/cli.ts";

describe("classifyInstalledVersion — direction-aware (flair#1778)", () => {
  test("installed AHEAD of latest is 'ahead', never 'outdated'", () => {
    expect(classifyInstalledVersion("0.55.0", "0.54.2")).toBe("ahead");
  });
  test("installed behind latest is 'outdated'", () => {
    expect(classifyInstalledVersion("0.54.2", "0.55.1")).toBe("outdated");
  });
  test("equal is 'current'", () => {
    expect(classifyInstalledVersion("0.54.2", "0.54.2")).toBe("current");
  });
  test("prerelease ordering via semver: rc ahead of a lower release; a higher release outdated vs rc", () => {
    expect(classifyInstalledVersion("0.56.0-rc.1", "0.55.1")).toBe("ahead");
    expect(classifyInstalledVersion("0.55.1", "0.56.0-rc.1")).toBe("outdated");
  });
  test("unparseable installed is 'unknown', never 'outdated', and never throws", () => {
    expect(classifyInstalledVersion("not-a-version", "0.55.1")).toBe("unknown");
    expect(classifyInstalledVersion("", "0.55.1")).toBe("unknown");
    expect(classifyInstalledVersion("1.2.3 || 4.5.6", "0.55.1")).toBe("unknown");
  });
});

describe("the hazard fixture renders with no arrow and no remedy (flair#1778)", () => {
  const line = formatUpgradeStatusLine({
    name: "@tpsdev-ai/flair",
    installed: "0.55.0",
    latest: "0.54.2",
    status: "ahead",
    suffix: upgradeStatusSuffix("@tpsdev-ai/flair", "ahead"),
  });

  test("no upgrade arrow and no '→ 0.54.2'", () => {
    expect(line).not.toContain("⬆️");
    expect(line).not.toContain("→");
    expect(line).not.toContain("→ 0.54.2");
  });
  test("names the ahead relationship and the installed version", () => {
    expect(line).toContain("0.55.0");
    expect(line).toContain("(ahead of latest 0.54.2)");
  });
  test("ahead carries no remedy suffix and still prints", () => {
    expect(upgradeStatusSuffix("@tpsdev-ai/flair", "ahead")).toBe("");
    expect(shouldPrintUpgradeLine("ahead", false)).toBe(true);
  });
});

describe("no regression on the existing renderer (flair#1778)", () => {
  test("outdated still renders the upgrade arrow", () => {
    expect(formatUpgradeStatusLine({ name: "x", installed: "0.54.2", latest: "0.55.1", status: "outdated" }))
      .toBe("  ⬆️ x: 0.54.2 → 0.55.1");
  });
  test("current renders the check and the (current) suffix", () => {
    expect(formatUpgradeStatusLine({ name: "x", installed: "0.55.1", latest: "0.55.1", status: "current", suffix: upgradeStatusSuffix("x", "current") }))
      .toBe("  ✅ x: 0.55.1 → 0.55.1 (current)");
  });
  test("unknown renders the raw string, no arrow (D6)", () => {
    const u = formatUpgradeStatusLine({ name: "x", installed: "bogus", latest: "1.0.0", status: "unknown" });
    expect(u).toContain("bogus");
    expect(u).toContain("unknown");
    expect(u).not.toContain("→");
  });
  test("missing keeps its install remedy", () => {
    expect(upgradeStatusSuffix("x", "missing")).toBe(" (run: npm install -g)");
  });
});

describe("resolveFlairMcpFinding produces 'ahead' (flair#1778)", () => {
  test("wired pin ahead of latest -> ahead, not outdated", () => {
    expect(resolveFlairMcpFinding(null, "0.54.2", { wired: true, pinnedVersion: "0.55.0" }))
      .toEqual({ installed: "0.55.0", status: "ahead" });
  });
  test("legacy global install ahead of latest -> ahead", () => {
    expect(resolveFlairMcpFinding("0.55.0", "0.54.2", { wired: false, pinnedVersion: null }))
      .toEqual({ installed: "0.55.0", status: "ahead" });
  });
  test("wired pin behind latest stays outdated (no regression)", () => {
    expect(resolveFlairMcpFinding(null, "0.55.1", { wired: true, pinnedVersion: "0.54.2" }))
      .toEqual({ installed: "0.54.2", status: "outdated" });
  });
  test("not wired stays missing", () => {
    expect(resolveFlairMcpFinding(null, "0.55.1", { wired: false, pinnedVersion: null }))
      .toEqual({ installed: null, status: "missing" });
  });
});

describe("pinWriteWouldLowerOrIsUnknown — the never-lower guard, FAIL CLOSED (flair#1778)", () => {
  test("true when the write would LOWER the pin (next < existing)", () => {
    expect(pinWriteWouldLowerOrIsUnknown("0.55.0", "0.54.2")).toBe(true);
    expect(pinWriteWouldLowerOrIsUnknown("0.54.2", "0.55.0")).toBe(false);
    expect(pinWriteWouldLowerOrIsUnknown("0.55.0", "0.55.0")).toBe(false);
  });
  test("true for EVERY unreadable-side case (cannot compare => fail closed)", () => {
    expect(pinWriteWouldLowerOrIsUnknown("0.55.1.rc", "0.55.1")).toBe(true); // invalid existing
    expect(pinWriteWouldLowerOrIsUnknown("0.55.1", "0.55.1.rc")).toBe(true); // invalid next
    expect(pinWriteWouldLowerOrIsUnknown("not-a-version", "garbage")).toBe(true); // both invalid
    expect(pinWriteWouldLowerOrIsUnknown("0.55.0", null)).toBe(true); // next absent
  });
  test("false only when the write is provably not a lowering AND a pin is present", () => {
    expect(pinWriteWouldLowerOrIsUnknown(null, "0.54.2")).toBe(false); // no pin to lower
    expect(pinWriteWouldLowerOrIsUnknown(undefined, undefined)).toBe(false);
  });
});

describe("comparePinVersions — the ONE pure comparison", () => {
  test("orders strict semver, null when either side cannot be compared", () => {
    expect(comparePinVersions("0.55.0", "0.54.2")).toBeGreaterThan(0);
    expect(comparePinVersions("0.54.2", "0.55.0")).toBeLessThan(0);
    expect(comparePinVersions("0.55.0", "0.55.0")).toBe(0);
    expect(comparePinVersions("0.55.1.rc", "0.55.1")).toBeNull();
    expect(comparePinVersions("0.55.1", "0.55.1.rc")).toBeNull();
    expect(comparePinVersions("0.55.1.rc", "garbage")).toBeNull();
    expect(comparePinVersions(null, "0.55.1")).toBeNull();
  });
});
