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
  formatEnableReport,
  formatStatusReport,
  describeLoadFailure,
  interpretActiveResult,
  type SchedulerSubstitutions,
  type EnableOpts,
  type EnableResult,
  type SchedulerStatus,
} from "../src/rem/scheduler.ts";
import { type FirstRunVerification } from "../src/lib/scheduler-platform.ts";

let testRoot: string;
let home: string;
let shimPath: string;
let plistPath: string;
let timerPath: string;
let servicePath: string;
let templateRoot: string;

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), "flair-rem-scheduler-test-"));
  home = join(testRoot, "home");
  mkdirSync(home, { recursive: true });
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
    // Pinned so shim-content assertions are hermetic — no dependency on what
    // resolveNodeBin() finds on the machine running the tests.
    nodeBin: "/usr/local/bin/node",
    shimPathOverride: shimPath,
    launchdPlistOverride: plistPath,
    systemdTimerOverride: timerPath,
    systemdServiceOverride: servicePath,
    // #1231: enable now mkdirs HOME/.flair/logs — keep it inside the temp
    // tree, never the real home directory.
    homeOverride: home,
    templateRootOverride: templateRoot,
    skipLoad: true,
    ...overrides,
  };
}

const sampleSubs: SchedulerSubstitutions = {
  FLAIR_BIN: "/usr/local/bin/flair",
  NODE_BIN: "/usr/local/bin/node",
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
    // #1231: run the CLI UNDER NODE (read permission suffices — survives
    // npm-pack tarball extraction stripping the exec bit), with the node
    // binary resolved to an ABSOLUTE path at enable time (no run-time PATH
    // lookup). This replaces the old direct-exec pin.
    expect(shim).toContain(`exec "/usr/local/bin/node" "/usr/local/bin/flair" rem nightly run-once`);
    expect(shim).not.toContain("exec /usr/local/bin/flair");
    expect(shim).not.toMatch(/exec\s+node\b/);
    expect(shim).toContain("#!/bin/sh");
  });

  it("creates HOME/.flair/logs with mode 0700 (#1231 — launchd spawn error 209 otherwise)", () => {
    const logsDir = join(home, ".flair", "logs");
    expect(existsSync(logsDir)).toBe(false);
    enableScheduler(baseOpts({ platformOverride: "darwin" }));
    expect(existsSync(logsDir)).toBe(true);
    // 0700 is load-bearing: the REM nightly log carries distillation
    // candidate CONTENT (memory text), not just counts.
    expect(statSync(logsDir).mode & 0o777).toBe(0o700);
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

  it("creates HOME/.flair/logs with mode 0700 (#1231 — systemd append: targets need the directory)", () => {
    const logsDir = join(home, ".flair", "logs");
    expect(existsSync(logsDir)).toBe(false);
    enableScheduler(baseOpts({ platformOverride: "linux" }));
    expect(existsSync(logsDir)).toBe(true);
    expect(statSync(logsDir).mode & 0o777).toBe(0o700);
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

  // flair#850 — schedulerStatus() must not claim active from file presence
  // alone. These use overrides + skipActiveCheck so the assertions are
  // hermetic (no real launchctl/systemctl dependency).

  it("reports installed=false, active=false when nothing was ever written", () => {
    const s = schedulerStatus({
      platformOverride: "linux",
      systemdTimerOverride: timerPath,
      systemdServiceOverride: servicePath,
      shimPathOverride: shimPath,
    });
    expect(s.installed).toBe(false);
    // Nothing written — there is nothing to be active either, and we know
    // that for certain (no need to shell out), so `false`, not `null`.
    expect(s.active).toBe(false);
  });

  it("does NOT report active=true purely because the timer file exists (the flair#850 bug shape)", () => {
    enableScheduler(baseOpts({ platformOverride: "linux" }));
    expect(existsSync(timerPath)).toBe(true);

    // skipActiveCheck simulates "we chose not to query" — installed files
    // alone must yield `active: null` (unknown), never `true`. A `true`
    // here would be the exact bug: inferring activation from file presence.
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

  it("darwin: installed=true, active=null when the plist exists but the check is skipped", () => {
    enableScheduler(baseOpts({ platformOverride: "darwin" }));
    const s = schedulerStatus({
      platformOverride: "darwin",
      launchdPlistOverride: plistPath,
      shimPathOverride: shimPath,
      skipActiveCheck: true,
    });
    expect(s.installed).toBe(true);
    expect(s.active).not.toBe(true);
    expect(s.active).toBeNull();
  });
});

describe("interpretActiveResult (flair#850 — genuine active state, not file presence)", () => {
  it("linux: 'active' stdout means active", () => {
    expect(interpretActiveResult("linux", 0, "active\n", "")).toBe(true);
  });

  it("linux: 'inactive' stdout means not active", () => {
    expect(interpretActiveResult("linux", 3, "inactive\n", "")).toBe(false);
  });

  it("linux: no session bus (empty stdout, connection-refused stderr) is treated as NOT active — not unknown", () => {
    // This is the exact traced production failure mode: `systemctl --user`
    // fails before it ever prints a status word.
    const r = interpretActiveResult("linux", 1, "", "Failed to connect to bus: No medium found\n");
    expect(r).toBe(false);
  });

  it("linux: total spawn failure with no output at all is inconclusive (null), not a confident false", () => {
    expect(interpretActiveResult("linux", null, "", "")).toBeNull();
  });

  it("darwin: exit code 0 means active", () => {
    expect(interpretActiveResult("darwin", 0, "some plist dump", "")).toBe(true);
  });

  it("darwin: nonzero exit with 'could not find service' means not active", () => {
    expect(interpretActiveResult("darwin", 3, "", "Could not find service \"dev.flair.rem.nightly\" in domain")).toBe(false);
  });

  it("darwin: total spawn failure with no output is inconclusive", () => {
    expect(interpretActiveResult("darwin", null, "", "")).toBeNull();
  });
});

describe("describeLoadFailure (flair#850 — remedy naming)", () => {
  it("names loginctl enable-linger for the traced 'no bus' linux failure", () => {
    const remedy = describeLoadFailure("linux", { code: 1, stderr: "Failed to connect to bus: No medium found\n" });
    expect(remedy).not.toBeNull();
    expect(remedy).toContain("loginctl enable-linger");
  });

  it("returns null for an unrecognized linux failure (caller falls back to raw stderr)", () => {
    const remedy = describeLoadFailure("linux", { code: 1, stderr: "some other systemd error\n" });
    expect(remedy).toBeNull();
  });

  it("returns null on darwin (no traced/verified remedy for launchctl failures)", () => {
    const remedy = describeLoadFailure("darwin", { code: 1, stderr: "Failed to connect to bus: No medium found\n" });
    expect(remedy).toBeNull();
  });
});

describe("formatEnableReport (flair#850 — the core honesty fix)", () => {
  const reportInput = { hour: 3, minute: 0, agentId: "test-agent", flairUrl: "http://127.0.0.1:9926" };
  const LOG_PATH = "/home/test/.flair/logs/rem-nightly.stderr.log";

  function verifiedRun(over: Partial<FirstRunVerification> = {}): FirstRunVerification {
    return {
      verified: true,
      outcome: "success",
      exitCode: 0,
      detail: "systemctl --user start flair-rem-nightly.service → ok",
      logPath: LOG_PATH,
      stderrTail: "",
      logEmpty: false,
      budgetMs: 12_000,
      ...over,
    };
  }

  function baseEnableResult(overrides: Partial<EnableResult> = {}): EnableResult {
    return {
      platform: "linux",
      shimPath: "/home/test/.flair/bin/flair-rem-nightly",
      schedulerPath: "/home/test/.config/systemd/user/flair-rem-nightly.timer",
      loadCommand: ["systemctl", "--user", "enable", "--now", "flair-rem-nightly.timer"],
      firstRunVerified: true,
      firstRun: verifiedRun(),
      ...overrides,
    };
  }

  it("SUCCESS PATH: reports success when loadResult.code === 0 AND the first run was verified", () => {
    const r = baseEnableResult({ loadResult: { code: 0, stdout: "", stderr: "" } });
    const { lines, ok } = formatEnableReport(r, reportInput);
    expect(ok).toBe(true);
    expect(lines.join("\n")).toContain("✅ REM nightly scheduler enabled");
    expect(lines.join("\n")).not.toMatch(/NOT activated/);
  });

  it("NO-CLAIM PATH (#1231): a loadResult-absent result WITHOUT firstRunVerified no longer reads as success", () => {
    // Pre-#1231 this shape was treated as success ("the CLI never sets
    // skipLoad"). That was one layer short: nothing about this result proves
    // a run ever happened, so the headline is now withheld.
    const r = baseEnableResult({ loadResult: undefined, firstRunVerified: false, firstRun: undefined });
    const { lines, ok } = formatEnableReport(r, reportInput);
    const text = lines.join("\n");
    expect(ok).toBe(false);
    expect(text).not.toContain("✅ REM nightly scheduler enabled");
    expect(text).toContain("never verified");
  });

  it("FAILURE PATH: does NOT print a success headline when loadResult.code !== 0", () => {
    const r = baseEnableResult({
      loadResult: { code: 1, stdout: "", stderr: "Failed to connect to bus: No medium found\n" },
    });
    const { lines, ok } = formatEnableReport(r, reportInput);
    const text = lines.join("\n");
    expect(ok).toBe(false);
    expect(text).not.toContain("✅ REM nightly scheduler enabled");
    expect(text).not.toMatch(/^✅/m);
    expect(text).toMatch(/NOT activated/);
  });

  it("FAILURE PATH: signals failure via ok=false (caller exits nonzero)", () => {
    const r = baseEnableResult({ loadResult: { code: 1, stdout: "", stderr: "boom\n" } });
    const { ok } = formatEnableReport(r, reportInput);
    expect(ok).toBe(false);
  });

  it("FAILURE PATH: names the loginctl remedy for the bus-connection failure", () => {
    const r = baseEnableResult({
      loadResult: { code: 1, stdout: "", stderr: "Failed to connect to bus: No medium found\n" },
    });
    const { lines } = formatEnableReport(r, reportInput);
    const text = lines.join("\n");
    expect(text).toContain("loginctl enable-linger");
  });

  it("FAILURE PATH: still surfaces the raw stderr and the failing command", () => {
    const r = baseEnableResult({
      loadResult: { code: 1, stdout: "", stderr: "Failed to connect to bus: No medium found\n" },
    });
    const { lines } = formatEnableReport(r, reportInput);
    const text = lines.join("\n");
    expect(text).toContain("systemctl --user enable --now flair-rem-nightly.timer");
    expect(text).toContain("code 1");
    expect(text).toContain("Failed to connect to bus");
  });

  it("FAILURE PATH: treats a null exit code (timeout/killed) as failure too", () => {
    const r = baseEnableResult({ loadResult: { code: null, stdout: "", stderr: "" } });
    const { ok } = formatEnableReport(r, reportInput);
    expect(ok).toBe(false);
  });

  it("FAILURE PATH on darwin: no invented remedy, but still reports NOT activated", () => {
    const r = baseEnableResult({
      platform: "darwin",
      schedulerPath: "/home/test/Library/LaunchAgents/dev.flair.rem.nightly.plist",
      loadCommand: ["launchctl", "bootstrap", "gui/501", "/home/test/Library/LaunchAgents/dev.flair.rem.nightly.plist"],
      loadResult: { code: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error\n" },
    });
    const { lines, ok } = formatEnableReport(r, reportInput);
    const text = lines.join("\n");
    expect(ok).toBe(false);
    expect(text).not.toContain("✅ REM nightly scheduler enabled");
    expect(text).toMatch(/NOT activated/);
    expect(text).toContain("Re-run the activation command above manually");
  });

  // ── #1231: activation succeeded, but the first RUN was not verified ──────
  // The load command exiting 0 proves the service manager ACCEPTED the job,
  // not that the job can run. The ✅ headline is additionally gated on
  // firstRunVerified.

  function failedRun(over: Partial<FirstRunVerification> = {}): FirstRunVerification {
    return {
      verified: false,
      outcome: "run-failed",
      exitCode: 126,
      detail: "launchctl print gui/501/dev.flair.rem.nightly → last exit code = 126",
      logPath: LOG_PATH,
      stderrTail: "",
      logEmpty: false,
      budgetMs: 12_000,
      ...over,
    };
  }

  it("#1231: load ok + first run FAILED refuses the ✅ headline with exit status + remedy", () => {
    const r = baseEnableResult({
      loadResult: { code: 0, stdout: "", stderr: "" },
      firstRunVerified: false,
      firstRun: failedRun({ stderrTail: "Error: connect ECONNREFUSED 127.0.0.1:9926" }),
    });
    const { lines, ok } = formatEnableReport(r, reportInput);
    const text = lines.join("\n");
    expect(ok).toBe(false);
    expect(text).not.toContain("✅ REM nightly scheduler enabled");
    expect(text).toContain("first run FAILED");
    expect(text).toContain("exit 126");
    // Kern's addition: the stderr tail from the log file is part of the report.
    expect(text).toContain("ECONNREFUSED");
    expect(text).toContain(LOG_PATH);
    // Remedy names THIS command.
    expect(text).toContain("flair rem nightly enable");
  });

  it("#1231: an EMPTY log file after a failed run is itself reported as diagnostic", () => {
    const r = baseEnableResult({
      loadResult: { code: 0, stdout: "", stderr: "" },
      firstRunVerified: false,
      firstRun: failedRun({ exitCode: 209, logEmpty: true }),
    });
    const text = formatEnableReport(r, reportInput).lines.join("\n");
    expect(text).toContain("EMPTY");
    expect(text).toContain("died before writing");
  });

  it("#1231: timeout withholds the headline but says the run may still be going", () => {
    const r = baseEnableResult({
      loadResult: { code: 0, stdout: "", stderr: "" },
      firstRunVerified: false,
      firstRun: failedRun({ outcome: "timeout", exitCode: null }),
    });
    const { lines, ok } = formatEnableReport(r, reportInput);
    const text = lines.join("\n");
    expect(ok).toBe(false);
    expect(text).not.toContain("✅ REM nightly scheduler enabled");
    expect(text).toContain("did not complete within 12s");
  });

  it("#1231: service manager unreachable is its OWN state — remedy points at the manager, not the job", () => {
    const r = baseEnableResult({
      loadResult: { code: 0, stdout: "", stderr: "" },
      firstRunVerified: false,
      firstRun: failedRun({ outcome: "manager-unavailable", exitCode: null, detail: "launchctl could not be run" }),
    });
    const { lines, ok } = formatEnableReport(r, reportInput);
    const text = lines.join("\n");
    expect(ok).toBe(false);
    expect(text).toContain("service manager is unreachable");
    expect(text).toContain("cannot verify the first run");
    expect(text).toContain("Fix the service manager");
    expect(text).not.toContain("first run FAILED");
  });

  it("#1231: enableScheduler with skipLoad reports firstRunVerified=false — never manufactured", () => {
    const r = enableScheduler(baseOpts({ platformOverride: "linux" }));
    expect(r.firstRunVerified).toBe(false);
    expect(r.firstRun).toBeUndefined();
  });

  it("#1279: a working-tree FLAIR_BIN does not flip ok, but the warning is on the success report", () => {
    const r = baseEnableResult({
      loadResult: { code: 0, stdout: "", stderr: "" },
      firstRunVerified: true,
      firstRun: verifiedRun(),
      flairBin: "/home/me/flair/dist/cli.js",
      flairBinCanonical: false,
      flairBinPublic: "/usr/local/bin/flair",
    });
    const { lines, ok } = formatEnableReport(r, reportInput);
    const text = lines.join("\n");
    expect(ok).toBe(true);
    expect(text).toContain("✅ REM nightly scheduler enabled");
    expect(text).toContain("FLAIR_BIN is /home/me/flair/dist/cli.js");
    expect(text).toContain("not a stable public entry");
    expect(text).toContain("flair rem nightly enable");
    expect(text).not.toContain("federation sync enable");
  });

  it("#1279: a canonical FLAIR_BIN produces no warning", () => {
    const r = baseEnableResult({
      loadResult: { code: 0, stdout: "", stderr: "" },
      firstRunVerified: true,
      firstRun: verifiedRun(),
      flairBin: "/usr/local/bin/flair",
      flairBinCanonical: true,
    });
    expect(formatEnableReport(r, reportInput).lines.join("\n")).not.toContain("FLAIR_BIN is");
  });
});

describe("enableScheduler — FLAIR_BIN capture (flair#1279)", () => {
  it("a public `flair` path is canonical and is what the shim execs under node", () => {
    const r = enableScheduler(baseOpts({ platformOverride: "linux", flairBin: "/usr/local/bin/flair" }));
    expect(r.flairBin).toBe("/usr/local/bin/flair");
    expect(r.flairBinCanonical).toBe(true);
    const shim = readFileSync(shimPath, "utf-8");
    expect(shim).toContain(`exec "/usr/local/bin/node" "/usr/local/bin/flair" rem nightly run-once`);
    expect(shim).not.toMatch(/exec\s+node\b/);
  });

  it("a working-tree dist/cli.js is baked as-is (not substituted) and marked not canonical", () => {
    const tree = join(testRoot, "checkout", "dist", "cli.js");
    const r = enableScheduler(baseOpts({ platformOverride: "linux", flairBin: tree }));
    expect(r.flairBin).toBe(tree);
    expect(r.flairBinCanonical).toBe(false);
    const shim = readFileSync(shimPath, "utf-8");
    expect(shim).toContain(`exec "/usr/local/bin/node" "${tree}" rem nightly run-once`);
    expect(shim).not.toMatch(/command -v flair/);
  });
});

describe("formatStatusReport (flair#850 — status reflects genuine active state)", () => {
  function baseStatus(overrides: Partial<SchedulerStatus> = {}): SchedulerStatus {
    return {
      platform: "linux",
      installed: true,
      active: true,
      schedulerPath: "/home/test/.config/systemd/user/flair-rem-nightly.timer",
      shimPath: "/home/test/.flair/bin/flair-rem-nightly",
      shimExists: true,
      ...overrides,
    };
  }

  it("reports Active: yes when genuinely active", () => {
    const { lines, ok } = formatStatusReport(baseStatus({ active: true }));
    expect(ok).toBe(true);
    expect(lines.join("\n")).toContain("Active:      yes");
  });

  it("reports Active: no — and does not claim enabled — when files exist but the job is not active (the flair#850 bug shape)", () => {
    const { lines, ok } = formatStatusReport(baseStatus({ installed: true, active: false }));
    const text = lines.join("\n");
    expect(ok).toBe(false);
    expect(text).toContain("Active:      no");
    expect(text).not.toMatch(/Active:\s+yes/);
    expect(text).toMatch(/nothing is scheduled/i);
  });

  it("reports Active: unknown when the check was inconclusive/skipped", () => {
    const { lines } = formatStatusReport(baseStatus({ installed: true, active: null }));
    expect(lines.join("\n")).toContain("Active:      unknown");
  });

  it("reports not-installed distinctly from installed-but-inactive", () => {
    const { lines } = formatStatusReport(baseStatus({ installed: false, active: false }));
    const text = lines.join("\n");
    expect(text).toContain("Installed:   no");
    expect(text).toContain("Enable with:");
    expect(text).not.toMatch(/nothing is scheduled/i);
  });
});
