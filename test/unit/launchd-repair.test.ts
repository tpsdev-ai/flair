/**
 * launchd-repair.test.ts — the DECISION half of the `doctor --fix` launchd
 * repair (flair#1573 slice b1).
 *
 * planLaunchdRepair / classifyPlist are pure: no filesystem, no launchctl.
 * This file pins the state matrix the adjudication made hard requirements:
 *
 *   - missing plist        -> regenerate (pass-file mode)
 *   - corrupt plist        -> regenerate
 *   - foreign ROOTPATH     -> refuse (ownership guard, flair#966 mirror)
 *   - unattributable       -> refuse (no ROOTPATH to prove ownership)
 *   - already-managed      -> no-op ("already managed")
 *   - detached-and-running (ours) -> adopt (clean-stop -> regenerate -> load)
 *   - detached-and-running (foreign) -> refuse (ownership guard)
 *   - config unreadable    -> refuse (config authority, flair#914)
 *   - not-applicable       -> no-op (not macOS)
 *
 * The EXECUTION (adopt: clean-stop -> regenerate -> load -> verify) lives in
 * src/cli.ts and is exercised by the real-launchd Darwin sandbox
 * (test/integration/doctor-fix-launchd-darwin.test.ts, flair#1581). The
 * executor's PURE helpers (mapRepairThrow for the try/catch, decideAdoptStop
 * for the post-stop port check) ARE pinned here.
 */

import { describe, test, expect } from "bun:test";
import {
  classifyPlist,
  planLaunchdRepair,
  mapRepairThrow,
  decideAdoptStop,
  type PlistDisposition,
} from "../../src/lib/launchd-repair.ts";
import type { LaunchdManagement } from "../../src/lib/launchd-management.ts";
import type { DaemonState, HealthResult } from "../../src/lib/daemon-liveness.ts";

const DATA_DIR = "/Users/example/.flair/data";
const PLIST_PATH = "/Users/example/Library/LaunchAgents/ai.tpsdev.flair.deadbeef.plist";

/** A minimal valid Flair plist (dict root, ROOTPATH present). */
function plistXml(rootPath: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>ai.tpsdev.flair.deadbeef</string>
  <key>ProgramArguments</key>
  <array><string>/usr/local/bin/node</string><string>/opt/flair/harper.js</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ROOTPATH</key><string>${rootPath}</string>
  </dict>
</dict>
</plist>`;
}

function observation(state: LaunchdManagement["state"], detail = "detail"): LaunchdManagement {
  return { state, detail };
}

// ─── classifyPlist: the ownership guard's first question ──────────────────

describe("classifyPlist", () => {
  const deps = (raw: string | null, rootPath: string | null) => ({
    exists: () => raw !== null,
    read: () => raw,
    readRootPath: () => rootPath,
  });

  test("absent: no plist file at the resolved path", () => {
    expect(classifyPlist(PLIST_PATH, DATA_DIR, deps(null, null))).toBe("absent");
  });

  test("corrupt: a file that is not XML (the reported bare JSON array)", () => {
    expect(classifyPlist(PLIST_PATH, DATA_DIR, deps("[1,2,3]", null))).toBe("corrupt");
  });

  test("corrupt: XML but no <dict> root", () => {
    expect(classifyPlist(PLIST_PATH, DATA_DIR, deps("<plist><array/></plist>", null))).toBe("corrupt");
  });

  test("ours: a valid plist whose ROOTPATH resolves to this data dir", () => {
    expect(classifyPlist(PLIST_PATH, DATA_DIR, deps(plistXml(DATA_DIR), DATA_DIR))).toBe("ours");
  });

  test("foreign: a valid plist whose ROOTPATH names a different data dir", () => {
    expect(classifyPlist(PLIST_PATH, DATA_DIR, deps(plistXml("/Users/other/.flair/data"), "/Users/other/.flair/data"))).toBe("foreign");
  });

  test("unattributable: a valid plist with no ROOTPATH at all", () => {
    const noRoot = plistXml(DATA_DIR).replace(/<key>ROOTPATH<\/key><string>[^<]*<\/string>/, "");
    expect(classifyPlist(PLIST_PATH, DATA_DIR, deps(noRoot, null))).toBe("unattributable");
  });
});

// ─── planLaunchdRepair: the decision matrix ───────────────────────────────

describe("planLaunchdRepair", () => {
  const input = (over: Partial<Parameters<typeof planLaunchdRepair>[0]> = {}) => ({
    observation: observation("detached"),
    disposition: "absent" as PlistDisposition,
    plistPath: PLIST_PATH,
    directProcessRunning: false,
    configReadable: true,
    ...over,
  });

  test("not-applicable (not macOS) -> no-op", () => {
    const plan = planLaunchdRepair(input({ observation: observation("not-applicable", "linux does not use launchd") }));
    expect(plan.kind).toBe("no-op");
    if (plan.kind === "no-op") expect(plan.reason).toBe("not-applicable");
  });

  test("already-managed -> no-op (idempotent second --fix)", () => {
    const plan = planLaunchdRepair(input({ observation: observation("managed", "launchd job is running") }));
    expect(plan.kind).toBe("no-op");
    if (plan.kind === "no-op") expect(plan.reason).toBe("already-managed");
  });

  test("missing plist -> regenerate", () => {
    const plan = planLaunchdRepair(input({ disposition: "absent" }));
    expect(plan.kind).toBe("regenerate");
  });

  test("corrupt plist -> regenerate", () => {
    const plan = planLaunchdRepair(input({ disposition: "corrupt" }));
    expect(plan.kind).toBe("regenerate");
  });

  test("ours (valid, unloaded) -> regenerate", () => {
    const plan = planLaunchdRepair(input({ disposition: "ours" }));
    expect(plan.kind).toBe("regenerate");
  });

  test("foreign ROOTPATH -> refuse (ownership guard, names the file)", () => {
    const plan = planLaunchdRepair(input({ disposition: "foreign" }));
    expect(plan.kind).toBe("refuse");
    if (plan.kind === "refuse") {
      expect(plan.reason).toBe("foreign");
      expect(plan.plistPath).toBe(PLIST_PATH);
      expect(plan.detail).toContain(PLIST_PATH);
    }
  });

  test("unattributable (no ROOTPATH) -> refuse", () => {
    const plan = planLaunchdRepair(input({ disposition: "unattributable" }));
    expect(plan.kind).toBe("refuse");
    if (plan.kind === "refuse") expect(plan.reason).toBe("unattributable");
  });

  test("config unreadable -> refuse (config authority, flair#914)", () => {
    const plan = planLaunchdRepair(input({ configReadable: false }));
    expect(plan.kind).toBe("refuse");
    if (plan.kind === "refuse") expect(plan.reason).toBe("config-unreadable");
  });

  test("detached-and-running (ours) -> adopt (bounces the live instance)", () => {
    const plan = planLaunchdRepair(input({ directProcessRunning: true }));
    expect(plan.kind).toBe("adopt");
    if (plan.kind === "adopt") expect(plan.detail).toContain("bounces");
  });

  test("detached-and-running (foreign) -> refuse (ownership guard)", () => {
    const plan = planLaunchdRepair(input({ disposition: "foreign", directProcessRunning: true }));
    expect(plan.kind).toBe("refuse");
    if (plan.kind === "refuse") expect(plan.reason).toBe("foreign");
  });

  test("config authority is checked BEFORE the ownership guard", () => {
    // A foreign plist with an unreadable config must refuse on config, not
    // on ownership — the config gate is the outermost safety rail.
    const plan = planLaunchdRepair(input({ disposition: "foreign", configReadable: false }));
    expect(plan.kind).toBe("refuse");
    if (plan.kind === "refuse") expect(plan.reason).toBe("config-unreadable");
  });
});

// ─── mapRepairThrow: the executor's try/catch (Kern's b1 defect) ──────────

describe("mapRepairThrow", () => {
  test("a plain throw -> failed result (doctor does NOT crash)", () => {
    const result = mapRepairThrow(new Error("boom"));
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.detail).toBe("boom");
      expect(result.remedy).toEqual(["flair doctor --fix"]);
    }
  });

  test("an engine-backwards throw -> refused (a refusal by nature)", () => {
    const err: any = new Error("engine is backwards");
    err.engineBackwards = true;
    const result = mapRepairThrow(err);
    expect(result.kind).toBe("refused");
    if (result.kind === "refused") {
      expect(result.reason).toBe("engine-backwards");
      expect(result.detail).toBe("engine is backwards");
    }
  });

  test("a non-Error throw -> failed with a string detail", () => {
    const result = mapRepairThrow("something broke");
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.detail).toBe("something broke");
  });
});

// ─── decideAdoptStop: the post-stop port check (flair#1573 slice b2) ──────

describe("decideAdoptStop", () => {
  const refused: HealthResult = { kind: "refused" };
  const ok: HealthResult = { kind: "ok" };

  test("RUNNING + port free -> proceed", () => {
    expect(decideAdoptStop({ state: "RUNNING", pid: 42 }, refused)).toBe("proceed");
  });

  test("WEDGED + port free -> proceed (recovery, not a recycled-pid gamble)", () => {
    expect(decideAdoptStop({ state: "WEDGED", pid: 42 }, refused)).toBe("proceed");
  });

  test("NOT_RUNNING + port free -> proceed", () => {
    expect(decideAdoptStop({ state: "NOT_RUNNING" }, refused)).toBe("proceed");
  });

  test("RUNNING + port still occupied -> failed (port still occupied)", () => {
    const result = decideAdoptStop({ state: "RUNNING", pid: 42 }, ok);
    expect(result).not.toBe("proceed");
    if (result !== "proceed") {
      expect(result.kind).toBe("failed");
      expect(result.detail).toContain("port still occupied");
    }
  });

  test("RUNNING + foreign HTTP still on the port -> failed (port still occupied)", () => {
    const result = decideAdoptStop({ state: "RUNNING", pid: 42 }, { kind: "foreign" });
    expect(result).not.toBe("proceed");
    if (result !== "proceed") {
      expect(result.kind).toBe("failed");
      expect(result.detail).toContain("port still occupied");
    }
  });

  test("RUNNING + port unreachable -> failed (NOT proceed — a wedged daemon may still hold the port)", () => {
    // "unreachable" is the probe's "cannot tell": a wedged daemon that ignored
    // SIGTERM but stays BOUND to the port while no longer serving /Health
    // would EADDRINUSE on load. It must NOT fall through to proceed.
    const result = decideAdoptStop({ state: "RUNNING", pid: 42 }, { kind: "unreachable" });
    expect(result).not.toBe("proceed");
    if (result !== "proceed") {
      expect(result.kind).toBe("failed");
      expect(result.detail).toContain("not confirmed free");
    }
  });

  test("DISAGREEMENT -> failed (never stop a foreign/unattributable process)", () => {
    const result = decideAdoptStop({ state: "DISAGREEMENT", detail: "identity unverified" }, refused);
    expect(result).not.toBe("proceed");
    if (result !== "proceed") {
      expect(result.kind).toBe("failed");
      expect(result.detail).toContain("refusing to adopt");
    }
  });

  test("UNKNOWN -> failed (never stop an unattributable process)", () => {
    const result = decideAdoptStop({ state: "UNKNOWN", detail: "cannot tell" }, refused);
    expect(result).not.toBe("proceed");
    if (result !== "proceed") expect(result.kind).toBe("failed");
  });
});
