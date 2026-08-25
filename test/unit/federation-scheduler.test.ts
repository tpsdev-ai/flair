/**
 * federation-scheduler.test.ts — unit tests for src/federation/scheduler.ts
 * (`flair federation sync enable|disable|status`, flair#922).
 *
 * SAFETY: every test writes into a fresh temp dir passed through the
 * *Override options, and every enable/disable passes skipLoad/skipUnload. No
 * test touches ~/Library/LaunchAgents, ~/.config/systemd, ~/.flair, or runs
 * launchctl/systemctl against the real user domain. Credential fixtures are
 * PATHS to placeholder files — never a real secret.
 *
 * Deliberately placed in test/unit/ rather than beside test/rem-scheduler.test.ts:
 * CI's unit lane runs `bun test test/unit/`, so the repo-root test files are
 * not gated by it (see the report on this PR).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  renderTemplate,
  renderPlistTemplate,
  enableScheduler,
  disableScheduler,
  schedulerStatus,
  parseInstalledInterval,
  validateInterval,
  assessDriver,
  freshnessWindowMs,
  formatEnableReport,
  formatStatusReport,
  DEFAULT_INTERVAL_SECONDS,
  MIN_INTERVAL_SECONDS,
  MAX_INTERVAL_SECONDS,
  type FederationSchedulerSubstitutions,
  type EnableOpts,
  type EnableResult,
  type SchedulerStatus,
  type DriverAssessmentInput,
} from "../../src/federation/scheduler.ts";
import { type FirstRunVerification } from "../../src/lib/scheduler-platform.ts";

let testRoot: string;
let home: string;
let shimPath: string;
let plistPath: string;
let timerPath: string;
let servicePath: string;
let passFile: string;
let templateRoot: string;

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), "flair-fed-scheduler-test-"));
  home = join(testRoot, "home");
  mkdirSync(home, { recursive: true });
  shimPath = join(testRoot, "bin", "flair-federation-sync");
  plistPath = join(testRoot, "LaunchAgents", "dev.flair.federation.sync.plist");
  timerPath = join(testRoot, "systemd", "flair-federation-sync.timer");
  servicePath = join(testRoot, "systemd", "flair-federation-sync.service");
  // A PATH fixture only. The scheduler must never read or copy the contents.
  passFile = join(testRoot, "admin-pass");
  writeFileSync(passFile, "PLACEHOLDER-not-a-real-password\n", { mode: 0o600 });
  templateRoot = resolve(import.meta.dir, "..", "..", "templates");
});

afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

function baseOpts(overrides: Partial<EnableOpts> = {}): EnableOpts {
  return {
    intervalSeconds: 300,
    flairBin: "/usr/local/bin/flair",
    // Pinned so shim-content assertions are hermetic — no dependency on what
    // resolveNodeBin() finds on the machine running the tests.
    nodeBin: "/usr/local/bin/node",
    shimPathOverride: shimPath,
    launchdPlistOverride: plistPath,
    systemdTimerOverride: timerPath,
    systemdServiceOverride: servicePath,
    homeOverride: home,
    templateRootOverride: templateRoot,
    skipLoad: true,
    ...overrides,
  };
}

const sampleSubs: FederationSchedulerSubstitutions = {
  FLAIR_BIN: "/usr/local/bin/flair",
  NODE_BIN: "/usr/local/bin/node",
  SHIM_PATH: "/Users/test/.flair/bin/flair-federation-sync",
  HOME: "/Users/test",
  INTERVAL_SECONDS: "300",
  ADMIN_PASS_FILE: "/Users/test/.flair/admin-pass",
  FLAIR_TARGET: "",
};

// ─── plist parsing (a malformed plist is silently never registered) ──────────

function have(cmd: string): boolean {
  try {
    execFileSync(cmd, ["--version"], { stdio: "pipe" });
    return true;
  } catch (e: any) {
    return e?.code !== "ENOENT";
  }
}
const HAS_PLUTIL = have("plutil");
const HAS_PYTHON = have("python3");
const PY_DUMP = "import plistlib,json,sys;json.dump(plistlib.load(open(sys.argv[1],'rb')),sys.stdout)";

/** Key-order-independent canonical form — plutil and plistlib disagree on order. */
function canonical(v: any): any {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    const out: Record<string, any> = {};
    for (const k of Object.keys(v).sort()) out[k] = canonical(v[k]);
    return out;
  }
  return v;
}

/**
 * Parse the plist with every real parser available and return the decoded
 * document. Throws if none is available rather than skipping — a parse check
 * that silently degrades into nothing still reads green.
 */
function parsePlist(plistText: string): any {
  const path = join(testRoot, "probe.plist");
  writeFileSync(path, plistText);
  const seen: any[] = [];
  if (HAS_PLUTIL) {
    execFileSync("plutil", ["-lint", path], { stdio: "pipe" });
    seen.push(JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", path], { encoding: "utf-8" })));
  }
  if (HAS_PYTHON) {
    seen.push(JSON.parse(execFileSync("python3", ["-c", PY_DUMP, path], { encoding: "utf-8", stdio: "pipe" })));
  }
  if (seen.length === 0) {
    throw new Error("no plist parser available (need plutil or python3) — refusing to skip a parse check");
  }
  for (const doc of seen) {
    expect(JSON.stringify(canonical(doc))).toBe(JSON.stringify(canonical(seen[0])));
  }
  return seen[0];
}

/** Unit-file directives only — assertions about shape must not match prose in comments. */
function directives(unitText: string): string {
  return unitText
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("#"))
    .join("\n");
}

describe("renderTemplate / renderPlistTemplate", () => {
  it("substitutes placeholders", () => {
    expect(renderTemplate("every {{INTERVAL_SECONDS}}s", sampleSubs)).toBe("every 300s");
  });

  it("throws on an unknown placeholder", () => {
    expect(() => renderTemplate("{{NOPE}}", sampleSubs)).toThrow(/unknown template placeholder: NOPE/);
  });

  it("XML-escapes into the plist but NOT into systemd/shim renders (#918)", () => {
    const subs = { ...sampleSubs, HOME: "/Users/a&b" };
    expect(renderPlistTemplate("{{HOME}}", subs)).toBe("/Users/a&amp;b");
    expect(renderTemplate("{{HOME}}", subs)).toBe("/Users/a&b");
  });
});

// ─── enable ─────────────────────────────────────────────────────────────────

describe("enableScheduler (darwin)", () => {
  it("writes a shim and a plist that PARSES, with the periodic-one-shot shape", () => {
    const r = enableScheduler(baseOpts({ platformOverride: "darwin", adminPassFile: passFile }));
    expect(r.platform).toBe("darwin");
    expect(r.schedulerPath).toBe(plistPath);
    expect(r.intervalSeconds).toBe(300);
    expect(existsSync(shimPath)).toBe(true);
    expect(existsSync(plistPath)).toBe(true);
    expect(statSync(shimPath).mode & 0o777).toBe(0o700);

    const doc = parsePlist(readFileSync(plistPath, "utf-8"));
    expect(doc.Label).toBe("dev.flair.federation.sync");
    expect(doc.ProgramArguments).toEqual([shimPath]);
    // The strategy decision, asserted: periodic one-shot, not a supervised
    // long-lived watcher.
    expect(doc.StartInterval).toBe(300);
    expect(doc.KeepAlive).toBeUndefined();
    // Sync immediately on enable so the operator sees it work.
    expect(doc.RunAtLoad).toBe(true);
    expect(doc.EnvironmentVariables.FLAIR_ADMIN_PASS_FILE).toBe(passFile);
    expect(readFileSync(plistPath, "utf-8")).not.toContain("{{");
  });

  it("puts the PASSWORD FILE PATH in the unit and never the password", () => {
    enableScheduler(baseOpts({ platformOverride: "darwin", adminPassFile: passFile }));
    const secret = readFileSync(passFile, "utf-8").trim();
    for (const p of [plistPath, shimPath]) {
      expect(readFileSync(p, "utf-8")).not.toContain(secret);
    }
    expect(readFileSync(plistPath, "utf-8")).toContain(passFile);
  });

  it("produces a plist that still parses when HOME contains XML metacharacters", () => {
    const weird = join(testRoot, "R&D<home>");
    mkdirSync(weird, { recursive: true });
    enableScheduler(baseOpts({ platformOverride: "darwin", homeOverride: weird }));
    const doc = parsePlist(readFileSync(plistPath, "utf-8"));
    expect(doc.EnvironmentVariables.HOME).toBe(weird);
  });

  it("is idempotent — re-enabling overwrites in place and changes the interval", () => {
    enableScheduler(baseOpts({ platformOverride: "darwin", intervalSeconds: 300 }));
    const first = readFileSync(plistPath, "utf-8");
    const r2 = enableScheduler(baseOpts({ platformOverride: "darwin", intervalSeconds: 900 }));
    const second = readFileSync(plistPath, "utf-8");

    expect(r2.intervalSeconds).toBe(900);
    expect(parsePlist(second).StartInterval).toBe(900);
    expect(second).not.toBe(first);
    // Re-enabling at the SAME interval must be byte-identical — no drift, no
    // accumulated duplication.
    enableScheduler(baseOpts({ platformOverride: "darwin", intervalSeconds: 900 }));
    expect(readFileSync(plistPath, "utf-8")).toBe(second);
    // Still exactly one plist and one shim.
    expect(existsSync(plistPath)).toBe(true);
    expect(existsSync(shimPath)).toBe(true);
  });

  it("does not invoke launchctl when skipLoad=true", () => {
    const r = enableScheduler(baseOpts({ platformOverride: "darwin" }));
    expect(r.loadResult).toBeUndefined();
    expect(r.loadCommand[0]).toBe("launchctl");
    expect(r.loadCommand).toContain("bootstrap");
  });
});

describe("enableScheduler (linux)", () => {
  it("writes a timer + service with the periodic-one-shot shape", () => {
    const r = enableScheduler(baseOpts({ platformOverride: "linux", adminPassFile: passFile }));
    expect(r.platform).toBe("linux");
    expect(r.schedulerPath).toBe(timerPath);
    expect(existsSync(timerPath)).toBe(true);
    expect(existsSync(servicePath)).toBe(true);

    const timer = readFileSync(timerPath, "utf-8");
    expect(timer).toContain("OnUnitActiveSec=300s");
    expect(timer).toContain("Unit=flair-federation-sync.service");
    expect(timer).toContain("WantedBy=timers.target");
    expect(timer).not.toContain("{{");

    const service = directives(readFileSync(servicePath, "utf-8"));
    expect(service).toContain("Type=oneshot");
    // The strategy decision, asserted: no supervised long-lived process.
    expect(service).not.toContain("Restart=");
    expect(service).toContain(`ExecStart=${shimPath}`);
    expect(service).toContain(`Environment=FLAIR_ADMIN_PASS_FILE=${passFile}`);
    // The timer carries [Install], not the service.
    expect(service).not.toContain("[Install]");
    // systemd units must NOT be XML-escaped — escaping there is corruption.
    expect(service).not.toContain("&amp;");
    expect(service).not.toContain("{{");
  });

  it("puts the PASSWORD FILE PATH in the unit and never the password", () => {
    enableScheduler(baseOpts({ platformOverride: "linux", adminPassFile: passFile }));
    const secret = readFileSync(passFile, "utf-8").trim();
    for (const p of [timerPath, servicePath, shimPath]) {
      expect(readFileSync(p, "utf-8")).not.toContain(secret);
    }
  });

  it("is idempotent — re-enabling overwrites in place and changes the interval", () => {
    enableScheduler(baseOpts({ platformOverride: "linux", intervalSeconds: 300 }));
    enableScheduler(baseOpts({ platformOverride: "linux", intervalSeconds: 600 }));
    const timer = readFileSync(timerPath, "utf-8");
    expect(timer).toContain("OnUnitActiveSec=600s");
    expect(timer).not.toContain("OnUnitActiveSec=300s");
    const again = enableScheduler(baseOpts({ platformOverride: "linux", intervalSeconds: 600 }));
    expect(readFileSync(timerPath, "utf-8")).toBe(timer);
    expect(again.intervalSeconds).toBe(600);
  });

  it("does not XML-escape a systemd unit even when a value carries an ampersand", () => {
    const weird = join(testRoot, "a&b");
    mkdirSync(weird, { recursive: true });
    enableScheduler(baseOpts({ platformOverride: "linux", homeOverride: weird }));
    expect(readFileSync(servicePath, "utf-8")).toContain(`${weird}/.flair/logs/federation-sync.stdout.log`);
  });
});

describe("enableScheduler validation", () => {
  it("rejects an interval below the floor, naming the alternative", () => {
    expect(() => enableScheduler(baseOpts({ intervalSeconds: 30 }))).toThrow(/interval must be 60-86400 seconds/);
    expect(() => enableScheduler(baseOpts({ intervalSeconds: 30 }))).toThrow(/federation watch/);
  });

  it("rejects an interval above the ceiling and a non-integer", () => {
    expect(() => enableScheduler(baseOpts({ intervalSeconds: MAX_INTERVAL_SECONDS + 1 }))).toThrow(/interval must be/);
    expect(() => enableScheduler(baseOpts({ intervalSeconds: 300.5 }))).toThrow(/whole number of seconds/);
  });

  it("accepts the boundaries", () => {
    expect(() => validateInterval(MIN_INTERVAL_SECONDS)).not.toThrow();
    expect(() => validateInterval(MAX_INTERVAL_SECONDS)).not.toThrow();
    expect(DEFAULT_INTERVAL_SECONDS).toBe(300);
  });

  it("refuses a credential path that does not exist rather than installing a driver that fails every cycle", () => {
    expect(() => enableScheduler(baseOpts({ adminPassFile: join(testRoot, "nope") }))).toThrow(/does not exist/);
  });
});

// ─── the log directory (#1231 mechanism 1) ──────────────────────────────────
// The unit files point stdout/stderr INTO ~/.flair/logs, and the service
// manager does not create that directory — launchd kills the job with spawn
// error 209. enable must create it.

describe("enableScheduler — log directory (#1231)", () => {
  for (const platformOverride of ["darwin", "linux"] as const) {
    it(`${platformOverride}: creates HOME/.flair/logs with mode 0700`, () => {
      const logsDir = join(home, ".flair", "logs");
      expect(existsSync(logsDir)).toBe(false);
      enableScheduler(baseOpts({ platformOverride }));
      expect(existsSync(logsDir)).toBe(true);
      // 0700 is load-bearing: the directory also receives REM's nightly log,
      // which carries distillation candidate CONTENT (memory text).
      expect(statSync(logsDir).mode & 0o777).toBe(0o700);
    });
  }

  it("reports a failed log-dir creation as its own failure, naming the directory", () => {
    // A FILE squatting on the logs path makes mkdir fail.
    mkdirSync(join(home, ".flair"), { recursive: true });
    writeFileSync(join(home, ".flair", "logs"), "not a directory\n");
    expect(() => enableScheduler(baseOpts({ platformOverride: "darwin" }))).toThrow(/log directory/);
    expect(() => enableScheduler(baseOpts({ platformOverride: "darwin" }))).toThrow(/federation sync enable/);
  });

  it("is idempotent when the directory already exists", () => {
    enableScheduler(baseOpts({ platformOverride: "linux" }));
    expect(() => enableScheduler(baseOpts({ platformOverride: "linux" }))).not.toThrow();
    expect(existsSync(join(home, ".flair", "logs"))).toBe(true);
  });
});

// ─── the shim ───────────────────────────────────────────────────────────────

describe("shim", () => {
  it("invokes the one-shot sync and passes the credential FILE PATH, not its contents", () => {
    enableScheduler(baseOpts({ platformOverride: "darwin", adminPassFile: passFile }));
    const shim = readFileSync(shimPath, "utf-8");
    expect(shim).toStartWith("#!/bin/sh");
    // #1231: run the CLI UNDER NODE (read permission suffices — survives
    // npm-pack tarball extraction stripping the exec bit), with the node
    // binary resolved to an ABSOLUTE path at enable time. This assertion
    // replaces the old deliberate pin on `exec "/usr/local/bin/flair"`.
    expect(shim).toContain(`exec "/usr/local/bin/node" "/usr/local/bin/flair" federation sync`);
    expect(shim).toContain("--admin-pass-file");
    // Never the value.
    expect(shim).not.toContain("PLACEHOLDER-not-a-real-password");
    expect(shim).not.toContain("{{");
  });

  it("never direct-execs FLAIR_BIN and never resolves node from PATH at run time", () => {
    enableScheduler(baseOpts({ platformOverride: "darwin" }));
    const shim = directives(readFileSync(shimPath, "utf-8"));
    // The exec-bit dependency (#1231): a direct exec of the script requires
    // +x, which tarball extraction strips.
    expect(shim).not.toContain(`exec "/usr/local/bin/flair"`);
    // Sherlock's finding on the fix: a bare `node` would introduce a run-time
    // PATH lookup the old absolute-path form never had.
    expect(shim).not.toMatch(/exec\s+node\b/);
  });

  it("is syntactically valid /bin/sh", () => {
    enableScheduler(baseOpts({ platformOverride: "linux" }));
    // -n parses without executing. Throws on a syntax error.
    execFileSync("/bin/sh", ["-n", shimPath], { stdio: "pipe" });
  });
});

// ─── disable ────────────────────────────────────────────────────────────────

describe("disableScheduler", () => {
  it("darwin: removes the plist, preserves the shim by default", () => {
    enableScheduler(baseOpts({ platformOverride: "darwin" }));
    const r = disableScheduler({
      platformOverride: "darwin",
      launchdPlistOverride: plistPath,
      shimPathOverride: shimPath,
      skipUnload: true,
    });
    expect(r.removed).toContain(plistPath);
    expect(existsSync(plistPath)).toBe(false);
    expect(existsSync(shimPath)).toBe(true);
  });

  it("darwin: removes the shim with removeShim", () => {
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

  it("linux: removes timer AND service", () => {
    enableScheduler(baseOpts({ platformOverride: "linux" }));
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

  it("is idempotent — disabling twice is a no-op the second time", () => {
    enableScheduler(baseOpts({ platformOverride: "darwin" }));
    const opts = {
      platformOverride: "darwin" as const,
      launchdPlistOverride: plistPath,
      shimPathOverride: shimPath,
      skipUnload: true,
    };
    expect(disableScheduler(opts).removed).toContain(plistPath);
    expect(disableScheduler(opts).removed).toEqual([]);
  });

  it("enable → disable → status returns to a clean not-installed state", () => {
    const statusOpts = {
      platformOverride: "darwin" as const,
      launchdPlistOverride: plistPath,
      shimPathOverride: shimPath,
      skipActiveCheck: true,
    };
    enableScheduler(baseOpts({ platformOverride: "darwin" }));
    expect(schedulerStatus(statusOpts).installed).toBe(true);
    disableScheduler({ ...statusOpts, skipUnload: true });
    const after = schedulerStatus(statusOpts);
    expect(after.installed).toBe(false);
    expect(after.active).toBe(false);
    expect(after.intervalSeconds).toBeNull();
  });
});

// ─── status: interval readback + no activation-by-file-presence ─────────────

describe("schedulerStatus", () => {
  it("reads the interval back OUT of the installed unit (darwin)", () => {
    enableScheduler(baseOpts({ platformOverride: "darwin", intervalSeconds: 420 }));
    const s = schedulerStatus({
      platformOverride: "darwin",
      launchdPlistOverride: plistPath,
      shimPathOverride: shimPath,
      skipActiveCheck: true,
    });
    expect(s.installed).toBe(true);
    expect(s.intervalSeconds).toBe(420);
  });

  it("reads the interval back OUT of the installed unit (linux)", () => {
    enableScheduler(baseOpts({ platformOverride: "linux", intervalSeconds: 720 }));
    const s = schedulerStatus({
      platformOverride: "linux",
      systemdTimerOverride: timerPath,
      systemdServiceOverride: servicePath,
      shimPathOverride: shimPath,
      skipActiveCheck: true,
    });
    expect(s.intervalSeconds).toBe(720);
  });

  it("does NOT claim active purely because the unit file exists (flair#850)", () => {
    enableScheduler(baseOpts({ platformOverride: "linux" }));
    const s = schedulerStatus({
      platformOverride: "linux",
      systemdTimerOverride: timerPath,
      systemdServiceOverride: servicePath,
      shimPathOverride: shimPath,
      skipActiveCheck: true,
    });
    expect(s.installed).toBe(true);
    expect(s.active).not.toBe(true);
    expect(s.active).toBeNull();
  });

  it("parseInstalledInterval returns null on a unit with no interval", () => {
    expect(parseInstalledInterval("darwin", "<plist><dict></dict></plist>")).toBeNull();
    expect(parseInstalledInterval("linux", "[Timer]\nOnCalendar=daily\n")).toBeNull();
    // Must not accept the OTHER platform's syntax.
    expect(parseInstalledInterval("linux", "<key>StartInterval</key><integer>300</integer>")).toBeNull();
  });
});

// ─── THE core behaviour: telling the three cases apart ───────────────────────

describe("assessDriver — driver present vs absent vs present-but-peer-unreachable", () => {
  const NOW = Date.parse("2026-07-28T12:00:00.000Z");
  const ago = (ms: number) => new Date(NOW - ms).toISOString();

  function input(over: Partial<DriverAssessmentInput> = {}): DriverAssessmentInput {
    return { installed: true, active: true, intervalSeconds: 300, lastSyncAt: ago(60_000), now: NOW, ...over };
  }

  it("CASE 1 — driver ABSENT and nothing syncing: says nothing is driving sync", () => {
    const a = assessDriver(input({ installed: false, active: false, intervalSeconds: null, lastSyncAt: ago(5 * 86_400_000) }));
    expect(a.verdict).toBe("no-driver");
    expect(a.driverActive).toBe(false);
    expect(a.headline).toMatch(/nothing is running federation sync/i);
    expect(a.remedy).toBe("flair federation sync enable");
    // Must NOT send the operator after the peer.
    expect(a.remedy).not.toMatch(/reachability/);
  });

  it("CASE 1b — never synced at all (the freshly-paired spoke) is also no-driver", () => {
    const a = assessDriver(input({ installed: false, active: false, intervalSeconds: null, lastSyncAt: null }));
    expect(a.verdict).toBe("no-driver");
    expect(a.detail).toMatch(/never/);
  });

  it("CASE 2 — driver PRESENT and syncs landing: healthy, no remedy", () => {
    const a = assessDriver(input({ lastSyncAt: ago(60_000) }));
    expect(a.verdict).toBe("driving");
    expect(a.driverActive).toBe(true);
    expect(a.contactFresh).toBe(true);
    expect(a.remedy).toBeNull();
    expect(a.headline).toMatch(/every 300s/);
  });

  it("CASE 3 — driver PRESENT but peer unreachable: blames the peer, NOT a missing scheduler", () => {
    const a = assessDriver(input({ lastSyncAt: ago(3 * 86_400_000) }));
    expect(a.verdict).toBe("driver-stalled");
    expect(a.driverActive).toBe(true);
    expect(a.contactFresh).toBe(false);
    expect(a.remedy).toMatch(/reachability/);
    // The distinction the whole issue is about: never tell someone whose
    // driver IS running to go enable a driver.
    expect(a.remedy).not.toMatch(/sync enable/);
    expect(a.detail).toMatch(/not a missing driver/i);
  });

  it("CASES 1 and 3 have the SAME peer staleness and DIFFERENT verdicts", () => {
    const stale = ago(3 * 86_400_000);
    const absent = assessDriver(input({ installed: false, active: false, intervalSeconds: null, lastSyncAt: stale }));
    const present = assessDriver(input({ lastSyncAt: stale }));
    expect(absent.verdict).not.toBe(present.verdict);
    expect(absent.remedy).not.toBe(present.remedy);
  });

  it("unit files on disk but the service manager has not loaded them", () => {
    const a = assessDriver(input({ installed: true, active: false, lastSyncAt: ago(3 * 86_400_000) }));
    expect(a.verdict).toBe("driver-inactive");
    expect(a.remedy).toBe("flair federation sync enable");
    expect(a.headline).toMatch(/INSTALLED BUT NOT LOADED/);
  });

  it("no managed driver but syncs ARE landing: reports an external driver, does not cry wolf", () => {
    const a = assessDriver(input({ installed: false, active: false, intervalSeconds: null, lastSyncAt: ago(60_000) }));
    expect(a.verdict).toBe("external-driver");
    expect(a.remedy).toBeNull();
    expect(a.detail).toMatch(/cron|watch/i);
  });

  it("an inconclusive service-manager query is reported as unknown, never as no-driver", () => {
    const a = assessDriver(input({ installed: true, active: null, lastSyncAt: ago(3 * 86_400_000) }));
    expect(a.verdict).toBe("unknown");
    expect(a.headline).not.toMatch(/NONE/);
  });

  it("freshness is three intervals with a five-minute floor", () => {
    expect(freshnessWindowMs(300)).toBe(900_000);
    expect(freshnessWindowMs(60)).toBe(300_000); // floor, not 180_000
    expect(freshnessWindowMs(null)).toBe(3_600_000);
  });

  it("a single missed cycle does not trip the stalled verdict; three do", () => {
    expect(assessDriver(input({ lastSyncAt: ago(310_000) })).verdict).toBe("driving");
    expect(assessDriver(input({ lastSyncAt: ago(1_000_000) })).verdict).toBe("driver-stalled");
  });

  it("an idle-but-healthy federation (contact fresh, nothing to merge) still reads as driving", () => {
    // Gating on lastMergeAt instead of lastSyncAt would re-create the original
    // bug here: a spoke with no new memories would report as not-driven.
    const a = assessDriver(input({ lastSyncAt: ago(30_000) }));
    expect(a.verdict).toBe("driving");
  });

  it("an unparseable lastSyncAt is treated as no contact, not as fresh contact", () => {
    const a = assessDriver(input({ installed: false, active: false, intervalSeconds: null, lastSyncAt: "not-a-date" }));
    expect(a.contactFresh).toBe(false);
    expect(a.verdict).toBe("no-driver");
  });
});

// ─── report formatting ──────────────────────────────────────────────────────

describe("formatEnableReport (flair#850 — no success headline before activation succeeded)", () => {
  const LOG_PATH = "/home/test/.flair/logs/federation-sync.stderr.log";

  function verifiedRun(over: Partial<FirstRunVerification> = {}): FirstRunVerification {
    return {
      verified: true,
      outcome: "success",
      exitCode: 0,
      detail: "systemctl --user start flair-federation-sync.service → ok",
      logPath: LOG_PATH,
      stderrTail: "",
      logEmpty: false,
      budgetMs: 12_000,
      ...over,
    };
  }

  function result(over: Partial<EnableResult> = {}): EnableResult {
    return {
      platform: "linux",
      shimPath: "/home/test/.flair/bin/flair-federation-sync",
      schedulerPath: "/home/test/.config/systemd/user/flair-federation-sync.timer",
      intervalSeconds: 300,
      loadCommand: ["systemctl", "--user", "enable", "--now", "flair-federation-sync.timer"],
      firstRunVerified: true,
      firstRun: verifiedRun(),
      ...over,
    };
  }

  it("reports success when the load succeeded AND the first run was verified", () => {
    const { lines, ok } = formatEnableReport(result({ loadResult: { code: 0, stdout: "", stderr: "" } }), {});
    expect(ok).toBe(true);
    expect(lines.join("\n")).toContain("✅ Federation sync driver enabled");
    expect(lines.join("\n")).toContain("First run:");
  });

  it("does NOT print a success headline when activation failed", () => {
    const { lines, ok } = formatEnableReport(
      result({ loadResult: { code: 1, stdout: "", stderr: "Failed to connect to bus: No medium found\n" } }),
      { lingerEnabled: false },
    );
    const text = lines.join("\n");
    expect(ok).toBe(false);
    expect(text).not.toMatch(/^✅/m);
    expect(text).toMatch(/NOT activated/);
    // The remedy names THIS command, not the REM one.
    expect(text).toContain("loginctl enable-linger");
    expect(text).toContain("flair federation sync enable");
    expect(text).not.toContain("rem nightly");
  });

  it("does not repeat the linger remedy after lingering is already on (flair#1107)", () => {
    const { lines, ok } = formatEnableReport(
      result({ loadResult: { code: 1, stdout: "", stderr: "Failed to connect to bus: No medium found\n" } }),
      { lingerEnabled: true, env: {} },
    );
    const text = lines.join("\n");
    expect(ok).toBe(false);
    expect(text).not.toContain("loginctl enable-linger <user>");
    expect(text).not.toMatch(/Fix: enable lingering/);
    expect(text).toContain("XDG_RUNTIME_DIR");
    expect(text).toContain("DBUS_SESSION_BUS_ADDRESS");
    expect(text).toContain("flair federation sync enable");
  });

  it("probes linger when lingerEnabled is omitted — the CLI path (flair#1107)", () => {
    // The CLI never passes lingerEnabled. Dropping this probe would reprint
    // `loginctl enable-linger` after it already ran, while every injected-facts
    // test still passed. The probe returning true must change the remedy.
    let probed = 0;
    const { lines } = formatEnableReport(
      result({ loadResult: { code: 1, stdout: "", stderr: "Failed to connect to bus: No medium found\n" } }),
      { probeLinger: () => { probed += 1; return true; }, env: {} },
    );
    expect(probed).toBe(1);
    const text = lines.join("\n");
    expect(text).not.toMatch(/Fix: enable lingering/);
    expect(text).not.toContain("loginctl enable-linger <user>");
    expect(text).toContain("XDG_RUNTIME_DIR");
  });

  it("treats a null exit code (timeout/killed) as failure", () => {
    expect(formatEnableReport(result({ loadResult: { code: null, stdout: "", stderr: "" } }), {}).ok).toBe(false);
  });

  it("names the credential file as a path and never claims a password was stored", () => {
    const { lines } = formatEnableReport(result({ loadResult: { code: 0, stdout: "", stderr: "" } }), {
      adminPassFile: "/home/test/.flair/admin-pass",
    });
    const text = lines.join("\n");
    expect(text).toContain("/home/test/.flair/admin-pass");
    expect(text).toContain("path only");
  });
});

describe("formatEnableReport (flair#1231 — no success headline before the FIRST RUN is verified)", () => {
  const LOG_PATH = "/home/test/.flair/logs/federation-sync.stderr.log";

  function firstRun(over: Partial<FirstRunVerification> = {}): FirstRunVerification {
    return {
      verified: false,
      outcome: "run-failed",
      exitCode: 1,
      detail: "launchctl print gui/501/dev.flair.federation.sync → last exit code = 1",
      logPath: LOG_PATH,
      stderrTail: "",
      logEmpty: false,
      budgetMs: 12_000,
      ...over,
    };
  }

  function result(over: Partial<EnableResult> = {}): EnableResult {
    return {
      platform: "darwin",
      shimPath: "/home/test/.flair/bin/flair-federation-sync",
      schedulerPath: "/home/test/Library/LaunchAgents/dev.flair.federation.sync.plist",
      intervalSeconds: 300,
      loadCommand: ["launchctl", "bootstrap", "gui/501", "/home/test/Library/LaunchAgents/dev.flair.federation.sync.plist"],
      loadResult: { code: 0, stdout: "", stderr: "" },
      firstRunVerified: false,
      firstRun: firstRun(),
      ...over,
    };
  }

  it("load ok + first run FAILED: refuses the ✅ headline and reports actor+state+remedy", () => {
    const { lines, ok } = formatEnableReport(
      result({
        firstRun: firstRun({
          exitCode: 126,
          detail: "launchctl print gui/501/dev.flair.federation.sync → last exit code = 126",
          stderrTail: "sh: /home/test/.flair/bin/flair-federation-sync: Permission denied",
        }),
      }),
      {},
    );
    const text = lines.join("\n");
    expect(ok).toBe(false);
    expect(text).not.toMatch(/^✅/m);
    // Actor + state: the DRIVER install worked, the RUN failed, with status.
    expect(text).toContain("first run FAILED");
    expect(text).toContain("exit 126");
    expect(text).toContain("Nothing has synced");
    // Diagnostics: the stderr tail from the log file.
    expect(text).toContain("Permission denied");
    expect(text).toContain(LOG_PATH);
    // Remedy: re-run THIS command after fixing.
    expect(text).toContain("flair federation sync enable");
  });

  it("an EMPTY log file after a failed run is itself reported as diagnostic", () => {
    const { lines } = formatEnableReport(
      result({ firstRun: firstRun({ exitCode: 209, stderrTail: "", logEmpty: true }) }),
      {},
    );
    const text = lines.join("\n");
    expect(text).toContain("EMPTY");
    expect(text).toContain("died before writing");
  });

  it("timeout: withholds the headline but says the run may still be going", () => {
    const { lines, ok } = formatEnableReport(
      result({ firstRun: firstRun({ outcome: "timeout", exitCode: null, detail: "no completed run visible within 12s" }) }),
      {},
    );
    const text = lines.join("\n");
    expect(ok).toBe(false);
    expect(text).not.toMatch(/^✅/m);
    expect(text).toContain("did not complete within 12s");
    expect(text).toMatch(/still be going/);
  });

  it("service manager unreachable is its OWN state — remedy points at the manager, not the sync job", () => {
    const { lines, ok } = formatEnableReport(
      result({ firstRun: firstRun({ outcome: "manager-unavailable", exitCode: null, detail: "launchctl could not be run" }) }),
      {},
    );
    const text = lines.join("\n");
    expect(ok).toBe(false);
    expect(text).not.toMatch(/^✅/m);
    expect(text).toContain("service manager is unreachable");
    expect(text).toContain("cannot verify the first run");
    expect(text).toContain("Fix the service manager");
    // NOT the run-failed wording — nothing is known to have failed.
    expect(text).not.toContain("first run FAILED");
  });

  it("a result with NO firstRun at all (load skipped / never attempted) still refuses the headline", () => {
    const { lines, ok } = formatEnableReport(result({ loadResult: undefined, firstRunVerified: false, firstRun: undefined }), {});
    const text = lines.join("\n");
    expect(ok).toBe(false);
    expect(text).not.toMatch(/^✅/m);
    expect(text).toContain("never verified");
  });

  it("enableScheduler with skipLoad reports firstRunVerified=false — the claim is never manufactured", () => {
    const r = enableScheduler(baseOpts({ platformOverride: "darwin" }));
    expect(r.firstRunVerified).toBe(false);
    expect(r.firstRun).toBeUndefined();
  });

  it("#1279: a working-tree FLAIR_BIN does not flip ok, but the warning is on the success report", () => {
    const { lines, ok } = formatEnableReport(
      result({
        loadResult: { code: 0, stdout: "", stderr: "" },
        firstRunVerified: true,
        firstRun: firstRun({ verified: true, outcome: "success", exitCode: 0 }),
        flairBin: "/home/me/flair/dist/cli.js",
        flairBinCanonical: false,
        flairBinPublic: "/usr/local/bin/flair",
      }),
      {},
    );
    const text = lines.join("\n");
    expect(ok).toBe(true);
    expect(text).toContain("✅ Federation sync driver enabled");
    expect(text).toContain("FLAIR_BIN is /home/me/flair/dist/cli.js");
    expect(text).toContain("not a stable public entry");
    expect(text).toContain("flair federation sync enable");
    expect(text).not.toContain("rem nightly");
  });

  it("#1279: a canonical FLAIR_BIN produces no warning", () => {
    const { lines } = formatEnableReport(
      result({
        loadResult: { code: 0, stdout: "", stderr: "" },
        firstRunVerified: true,
        firstRun: firstRun({ verified: true, outcome: "success", exitCode: 0 }),
        flairBin: "/usr/local/bin/flair",
        flairBinCanonical: true,
      }),
      {},
    );
    expect(lines.join("\n")).not.toContain("FLAIR_BIN is");
  });
});

describe("enableScheduler — FLAIR_BIN capture (flair#1279)", () => {
  it("a public `flair` path is canonical and is what the shim execs under node", () => {
    const r = enableScheduler(baseOpts({ platformOverride: "linux", flairBin: "/usr/local/bin/flair" }));
    expect(r.flairBin).toBe("/usr/local/bin/flair");
    expect(r.flairBinCanonical).toBe(true);
    const shim = readFileSync(shimPath, "utf-8");
    expect(shim).toContain(`exec "/usr/local/bin/node" "/usr/local/bin/flair" federation sync`);
    expect(shim).not.toMatch(/exec\s+node\b/);
  });

  it("a working-tree dist/cli.js is baked as-is (not substituted) and marked not canonical", () => {
    const tree = join(testRoot, "checkout", "dist", "cli.js");
    const r = enableScheduler(baseOpts({ platformOverride: "linux", flairBin: tree }));
    expect(r.flairBin).toBe(tree);
    expect(r.flairBinCanonical).toBe(false);
    const shim = readFileSync(shimPath, "utf-8");
    // Still #1231's exec-node form — the baked path is the script, not a PATH lookup.
    expect(shim).toContain(`exec "/usr/local/bin/node" "${tree}" federation sync`);
    expect(shim).not.toMatch(/command -v flair/);
  });

  it("a relative capture is resolved to an absolute path before it is baked", () => {
    const r = enableScheduler(baseOpts({ platformOverride: "darwin", flairBin: "dist/cli.js" }));
    const baked = r.flairBin;
    if (baked === undefined) throw new Error("enableScheduler must set flairBin");
    expect(baked).toBe(resolve("dist/cli.js"));
    expect(baked.startsWith("/")).toBe(true);
    expect(r.flairBinCanonical).toBe(false);
    const shim = readFileSync(shimPath, "utf-8");
    expect(shim).toContain(`exec "/usr/local/bin/node" "${resolve("dist/cli.js")}" federation sync`);
    expect(shim).not.toContain(`exec "/usr/local/bin/node" "dist/cli.js"`);
  });
});

describe("formatStatusReport", () => {
  const NOW = Date.parse("2026-07-28T12:00:00.000Z");
  function status(over: Partial<SchedulerStatus> = {}): SchedulerStatus {
    return {
      platform: "linux",
      installed: true,
      active: true,
      intervalSeconds: 300,
      schedulerPath: "/home/test/.config/systemd/user/flair-federation-sync.timer",
      shimPath: "/home/test/.flair/bin/flair-federation-sync",
      shimExists: true,
      ...over,
    };
  }

  it("a healthy driver reports Active: yes and ok", () => {
    const s = status();
    const a = assessDriver({ installed: true, active: true, intervalSeconds: 300, lastSyncAt: new Date(NOW - 60_000).toISOString(), now: NOW });
    const { lines, ok } = formatStatusReport(s, a);
    expect(ok).toBe(true);
    expect(lines.join("\n")).toContain("Active:      yes");
    expect(lines.join("\n")).toContain("Interval:    every 300s");
  });

  it("no driver reports Active: no, ok=false, and the enable remedy", () => {
    const s = status({ installed: false, active: false, intervalSeconds: null });
    const a = assessDriver({ installed: false, active: false, intervalSeconds: null, lastSyncAt: null, now: NOW });
    const { lines, ok } = formatStatusReport(s, a);
    const text = lines.join("\n");
    expect(ok).toBe(false);
    expect(text).toContain("Active:      no");
    expect(text).toContain("Run: flair federation sync enable");
  });

  it("a stalled driver reports Active: yes but is still not ok, and points at the peer", () => {
    const s = status();
    const a = assessDriver({ installed: true, active: true, intervalSeconds: 300, lastSyncAt: new Date(NOW - 3 * 86_400_000).toISOString(), now: NOW });
    const { lines, ok } = formatStatusReport(s, a);
    const text = lines.join("\n");
    expect(ok).toBe(false);
    expect(text).toContain("Active:      yes");
    expect(text).toMatch(/reachability/);
  });
});
