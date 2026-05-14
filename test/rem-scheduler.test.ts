/**
 * rem-scheduler.test.ts — Unit tests for src/rem/scheduler.ts.
 *
 * Filesystem coverage + template substitution. The launchctl/systemctl
 * spawn is opted out of (skipLoad/skipUnload) so tests run in isolation.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, mkdtempSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  renderTemplate,
  enableScheduler,
  disableScheduler,
  schedulerStatus,
  type SchedulerSubstitutions,
  type EnableOpts,
} from "../src/rem/scheduler.ts";

let testRoot: string;
let shimPath: string;
let plistPath: string;
let timerPath: string;
let servicePath: string;
let templateRoot: string;

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), "flair-rem-scheduler-test-"));
  shimPath = join(testRoot, "bin", "flair-rem-nightly");
  plistPath = join(testRoot, "LaunchAgents", "dev.flair.rem.nightly.plist");
  timerPath = join(testRoot, "systemd", "flair-rem-nightly.timer");
  servicePath = join(testRoot, "systemd", "flair-rem-nightly.service");
  templateRoot = resolve(import.meta.dir, "..", "templates");
});

afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

function baseOpts(overrides: Partial<EnableOpts> = {}): EnableOpts {
  return {
    agentId: "test-agent",
    flairUrl: "http://127.0.0.1:9926",
    hour: 3,
    minute: 0,
    flairBin: "/usr/local/bin/flair",
    shimPathOverride: shimPath,
    launchdPlistOverride: plistPath,
    systemdTimerOverride: timerPath,
    systemdServiceOverride: servicePath,
    templateRootOverride: templateRoot,
    skipLoad: true,
    ...overrides,
  };
}

const sampleSubs: SchedulerSubstitutions = {
  FLAIR_BIN: "/usr/local/bin/flair",
  SHIM_PATH: "/Users/test/.flair/bin/flair-rem-nightly",
  HOME: "/Users/test",
  AGENT_ID: "test-agent",
  FLAIR_URL: "http://127.0.0.1:9926",
  HOUR: "3",
  HOUR_PAD: "03",
  MINUTE: "0",
  MINUTE_PAD: "00",
};

describe("renderTemplate", () => {
  it("substitutes single placeholder", () => {
    expect(renderTemplate("hello {{AGENT_ID}}", sampleSubs)).toBe("hello test-agent");
  });

  it("substitutes multiple placeholders", () => {
    expect(renderTemplate("{{HOUR}}:{{MINUTE_PAD}}", sampleSubs)).toBe("3:00");
  });

  it("throws on unknown placeholder", () => {
    expect(() => renderTemplate("{{UNKNOWN}}", sampleSubs)).toThrow(/unknown template placeholder: UNKNOWN/);
  });

  it("ignores text without placeholders", () => {
    expect(renderTemplate("plain text", sampleSubs)).toBe("plain text");
  });
});

describe("enableScheduler (darwin)", () => {
  it("writes shim and plist with substitutions applied", () => {
    const r = enableScheduler(baseOpts({ platformOverride: "darwin" }));
    expect(r.platform).toBe("darwin");
    expect(r.schedulerPath).toBe(plistPath);
    expect(r.shimPath).toBe(shimPath);

    expect(existsSync(shimPath)).toBe(true);
    expect(existsSync(plistPath)).toBe(true);

    // Shim is executable.
    expect(statSync(shimPath).mode & 0o777).toBe(0o700);

    const plist = readFileSync(plistPath, "utf-8");
    expect(plist).toContain("<key>Label</key>");
    expect(plist).toContain("<string>dev.flair.rem.nightly</string>");
    expect(plist).toContain(`<string>${shimPath}</string>`);
    expect(plist).toContain("<integer>3</integer>");
    expect(plist).toContain("<integer>0</integer>");
    expect(plist).toContain("test-agent");
    expect(plist).toContain("http://127.0.0.1:9926");
    // No unresolved placeholders.
    expect(plist).not.toContain("{{");

    const shim = readFileSync(shimPath, "utf-8");
    expect(shim).toContain("/usr/local/bin/flair rem nightly run-once");
    expect(shim).toContain("#!/bin/sh");
  });

  it("does not invoke launchctl when skipLoad=true", () => {
    const r = enableScheduler(baseOpts({ platformOverride: "darwin" }));
    expect(r.loadResult).toBeUndefined();
    expect(r.loadCommand[0]).toBe("launchctl");
    expect(r.loadCommand).toContain("bootstrap");
  });
});

describe("enableScheduler (linux)", () => {
  it("writes shim, service, and timer with substitutions applied", () => {
    const r = enableScheduler(baseOpts({ platformOverride: "linux" }));
    expect(r.platform).toBe("linux");
    expect(r.schedulerPath).toBe(timerPath);

    expect(existsSync(shimPath)).toBe(true);
    expect(existsSync(timerPath)).toBe(true);
    expect(existsSync(servicePath)).toBe(true);

    const timer = readFileSync(timerPath, "utf-8");
    expect(timer).toContain("OnCalendar=*-*-* 03:00:00");
    expect(timer).toContain("Unit=flair-rem-nightly.service");
    expect(timer).not.toContain("{{");

    const service = readFileSync(servicePath, "utf-8");
    expect(service).toContain(`ExecStart=${shimPath}`);
    expect(service).toContain("Environment=FLAIR_AGENT_ID=test-agent");
    expect(service).toContain("Environment=FLAIR_URL=http://127.0.0.1:9926");
    expect(service).not.toContain("{{");
  });

  it("zero-pads hour and minute for systemd OnCalendar", () => {
    const r = enableScheduler(baseOpts({ platformOverride: "linux", hour: 7, minute: 5 }));
    const timer = readFileSync(timerPath, "utf-8");
    expect(timer).toContain("OnCalendar=*-*-* 07:05:00");
  });
});

describe("enableScheduler validation", () => {
  it("rejects invalid hour", () => {
    expect(() => enableScheduler(baseOpts({ hour: 24 }))).toThrow(/hour must be/);
    expect(() => enableScheduler(baseOpts({ hour: -1 }))).toThrow(/hour must be/);
    expect(() => enableScheduler(baseOpts({ hour: 3.5 }))).toThrow(/hour must be/);
  });

  it("rejects invalid minute", () => {
    expect(() => enableScheduler(baseOpts({ minute: 60 }))).toThrow(/minute must be/);
    expect(() => enableScheduler(baseOpts({ minute: -1 }))).toThrow(/minute must be/);
  });

  it("rejects invalid agent id", () => {
    expect(() => enableScheduler(baseOpts({ agentId: "../etc" }))).toThrow(/invalid agent id/);
    expect(() => enableScheduler(baseOpts({ agentId: "" }))).toThrow(/invalid agent id/);
  });
});

describe("disableScheduler (darwin)", () => {
  it("removes the plist after install", () => {
    enableScheduler(baseOpts({ platformOverride: "darwin" }));
    expect(existsSync(plistPath)).toBe(true);

    const r = disableScheduler({
      platformOverride: "darwin",
      launchdPlistOverride: plistPath,
      shimPathOverride: shimPath,
      skipUnload: true,
    });
    expect(r.removed).toContain(plistPath);
    expect(existsSync(plistPath)).toBe(false);
    // Shim preserved by default.
    expect(existsSync(shimPath)).toBe(true);
  });

  it("removes the shim when removeShim=true", () => {
    enableScheduler(baseOpts({ platformOverride: "darwin" }));
    const r = disableScheduler({
      platformOverride: "darwin",
      launchdPlistOverride: plistPath,
      shimPathOverride: shimPath,
      skipUnload: true,
      removeShim: true,
    });
    expect(r.removed).toContain(shimPath);
    expect(existsSync(shimPath)).toBe(false);
  });

  it("is idempotent — disable on a non-installed state returns no-op", () => {
    const r = disableScheduler({
      platformOverride: "darwin",
      launchdPlistOverride: plistPath,
      shimPathOverride: shimPath,
      skipUnload: true,
    });
    expect(r.removed).toEqual([]);
  });
});

describe("disableScheduler (linux)", () => {
  it("removes timer + service after install", () => {
    enableScheduler(baseOpts({ platformOverride: "linux" }));
    expect(existsSync(timerPath)).toBe(true);
    expect(existsSync(servicePath)).toBe(true);

    const r = disableScheduler({
      platformOverride: "linux",
      systemdTimerOverride: timerPath,
      systemdServiceOverride: servicePath,
      shimPathOverride: shimPath,
      skipUnload: true,
    });
    expect(r.removed.sort()).toEqual([servicePath, timerPath].sort());
    expect(existsSync(timerPath)).toBe(false);
    expect(existsSync(servicePath)).toBe(false);
  });
});

describe("schedulerStatus", () => {
  // Status uses default paths, so we verify the function shape only.
  it("returns the platform + paths it would check", () => {
    const s = schedulerStatus({ platformOverride: "darwin" });
    expect(s.platform).toBe("darwin");
    expect(s.schedulerPath).toContain("dev.flair.rem.nightly.plist");
    expect(s.shimPath).toContain("flair-rem-nightly");
  });

  it("reports linux paths under linux", () => {
    const s = schedulerStatus({ platformOverride: "linux" });
    expect(s.platform).toBe("linux");
    expect(s.schedulerPath).toContain("flair-rem-nightly.timer");
  });
});
