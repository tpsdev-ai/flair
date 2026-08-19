/**
 * scheduler-first-run-verify.test.ts — unit tests for the flair#1231
 * primitives in src/lib/scheduler-platform.ts: first-run verification through
 * the service manager, enable-time node resolution, and the parsers/helpers
 * they stand on.
 *
 * SAFETY: every verifyFirstRun call injects `hooks.run` (and `hooks.sleep` /
 * `hooks.now` where timing matters), so no test spawns a real launchctl or
 * systemctl and none touches the user's service-manager domain. Log-file
 * fixtures live in a fresh temp dir.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveNodeBin,
  verifyFirstRun,
  parseLaunchdPrintExit,
  parseSystemdShowExit,
  readLogTail,
  describeExitCode,
  FIRST_RUN_POLL_INTERVAL_MS,
  FIRST_RUN_BUDGET_MS,
  type SpawnReport,
} from "../../src/lib/scheduler-platform.ts";

let testRoot: string;
let logPath: string;

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), "flair-first-run-verify-test-"));
  logPath = join(testRoot, "job.stderr.log");
});

afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

/** Builds a run hook that replays canned responses per command name. */
function cannedRun(responses: Array<{ match: (cmd: string[]) => boolean; reply: SpawnReport | (() => SpawnReport) }>) {
  const calls: string[][] = [];
  const run = (cmd: string[], _timeoutMs: number): SpawnReport => {
    calls.push(cmd);
    for (const r of responses) {
      if (r.match(cmd)) return typeof r.reply === "function" ? r.reply() : r.reply;
    }
    throw new Error(`unexpected command in test: ${cmd.join(" ")}`);
  };
  return { run, calls };
}

const ok: SpawnReport = { code: 0, stdout: "", stderr: "" };
const isKickstart = (c: string[]) => c[1] === "kickstart";
const isPrint = (c: string[]) => c[1] === "print";
const isStart = (c: string[]) => c[2] === "start";
const isShow = (c: string[]) => c[2] === "show";

const PRINT_RUNNING = "gui/501/dev.flair.test = {\n\tstate = running\n\tpid = 4242\n}\n";
const PRINT_NEVER = "gui/501/dev.flair.test = {\n\tstate = not running\n\tlast exit code = (never exited)\n}\n";
const printExited = (code: number) => `gui/501/dev.flair.test = {\n\tstate = not running\n\tlast exit code = ${code}\n}\n`;

// ─── constants pinned to the spec (addendum: 100–200ms poll, 10–15s budget) ──

describe("first-run verification constants", () => {
  it("poll interval is 100–200ms and the budget is 10–15s", () => {
    expect(FIRST_RUN_POLL_INTERVAL_MS).toBeGreaterThanOrEqual(100);
    expect(FIRST_RUN_POLL_INTERVAL_MS).toBeLessThanOrEqual(200);
    expect(FIRST_RUN_BUDGET_MS).toBeGreaterThanOrEqual(10_000);
    expect(FIRST_RUN_BUDGET_MS).toBeLessThanOrEqual(15_000);
  });
});

// ─── parsers ────────────────────────────────────────────────────────────────

describe("parseLaunchdPrintExit", () => {
  it("running job: pid/state present, no completed exit", () => {
    expect(parseLaunchdPrintExit(PRINT_RUNNING)).toEqual({ running: true, lastExitCode: null });
  });

  it("never-exited job: not running, no numeric exit code yet", () => {
    expect(parseLaunchdPrintExit(PRINT_NEVER)).toEqual({ running: false, lastExitCode: null });
  });

  it("completed job: reads the recorded exit code", () => {
    expect(parseLaunchdPrintExit(printExited(0))).toEqual({ running: false, lastExitCode: 0 });
    expect(parseLaunchdPrintExit(printExited(126))).toEqual({ running: false, lastExitCode: 126 });
  });

  it("accepts the 'last exit status' spelling too", () => {
    expect(parseLaunchdPrintExit("state = not running\nlast exit status = 3\n").lastExitCode).toBe(3);
  });
});

describe("parseSystemdShowExit", () => {
  it("reads ExecMainStatus and Result", () => {
    expect(parseSystemdShowExit("ExecMainStatus=1\nResult=exit-code\n")).toEqual({ execMainStatus: 1, result: "exit-code" });
    expect(parseSystemdShowExit("ExecMainStatus=0\nResult=success\n")).toEqual({ execMainStatus: 0, result: "success" });
  });

  it("returns nulls on unparseable output rather than inventing a status", () => {
    expect(parseSystemdShowExit("")).toEqual({ execMainStatus: null, result: null });
  });
});

// ─── helpers ────────────────────────────────────────────────────────────────

describe("readLogTail", () => {
  it("distinguishes missing, empty and populated log files", () => {
    expect(readLogTail(join(testRoot, "nope.log"))).toEqual({ exists: false, empty: false, tail: "" });
    writeFileSync(logPath, "");
    expect(readLogTail(logPath)).toEqual({ exists: true, empty: true, tail: "" });
    writeFileSync(logPath, "line1\nline2\n");
    expect(readLogTail(logPath)).toEqual({ exists: true, empty: false, tail: "line1\nline2" });
  });

  it("returns only the last N lines of a long log", () => {
    writeFileSync(logPath, Array.from({ length: 50 }, (_, i) => `line${i}`).join("\n"));
    const { tail } = readLogTail(logPath, 3);
    expect(tail).toBe("line47\nline48\nline49");
  });
});

describe("describeExitCode", () => {
  it("names the known failure classes so reports lead with actor+state", () => {
    expect(describeExitCode(126)).toContain("permission denied");
    expect(describeExitCode(127)).toContain("command not found");
    expect(describeExitCode(209)).toContain("log directory");
    expect(describeExitCode(1)).toBe("exit 1");
    expect(describeExitCode(null)).toContain("no exit status");
  });
});

// ─── resolveNodeBin (#1231, Sherlock: no run-time PATH lookup in the shim) ──

describe("resolveNodeBin", () => {
  it("an explicit override wins untouched", () => {
    expect(resolveNodeBin("/opt/node/bin/node")).toBe("/opt/node/bin/node");
  });

  it("resolves an ABSOLUTE existing path or fails loudly — never a bare name", () => {
    let out: string;
    try {
      out = resolveNodeBin();
    } catch (e: any) {
      // A machine with no node anywhere: enable must fail loudly rather than
      // bake a PATH lookup into the shim.
      expect(String(e?.message)).toMatch(/absolute path to a node binary/);
      return;
    }
    expect(out.startsWith("/")).toBe(true);
    expect(existsSync(out)).toBe(true);
  });
});

// ─── verifyFirstRun: darwin (kickstart + poll) ──────────────────────────────

describe("verifyFirstRun (darwin)", () => {
  const target = "gui/501/dev.flair.test";

  it("polls launchctl print until a completed exit-0 run is visible → verified", () => {
    let printCall = 0;
    const { run, calls } = cannedRun([
      { match: isKickstart, reply: ok },
      {
        match: isPrint,
        reply: () => {
          printCall++;
          // First two polls: still running. Third: completed cleanly.
          const body = printCall < 3 ? PRINT_RUNNING : printExited(0);
          return { code: 0, stdout: body, stderr: "" };
        },
      },
    ]);
    const sleeps: number[] = [];
    const r = verifyFirstRun({
      plat: "darwin",
      darwinTarget: target,
      stderrLogPath: logPath,
      hooks: { run, sleep: (ms) => sleeps.push(ms), now: Date.now },
    });
    expect(r.verified).toBe(true);
    expect(r.outcome).toBe("success");
    expect(r.exitCode).toBe(0);
    // It genuinely polled (kickstart returns immediately — the exit status
    // must be READ, not assumed), at the configured interval.
    expect(calls.filter(isPrint).length).toBe(3);
    expect(sleeps.every((ms) => ms === FIRST_RUN_POLL_INTERVAL_MS)).toBe(true);
    expect(sleeps.length).toBe(2);
  });

  it("a nonzero recorded exit is run-failed and carries the stderr tail from the log", () => {
    writeFileSync(logPath, "sh: permission denied\n");
    const { run } = cannedRun([
      { match: isKickstart, reply: ok },
      { match: isPrint, reply: { code: 0, stdout: printExited(126), stderr: "" } },
    ]);
    const r = verifyFirstRun({ plat: "darwin", darwinTarget: target, stderrLogPath: logPath, hooks: { run } });
    expect(r.verified).toBe(false);
    expect(r.outcome).toBe("run-failed");
    expect(r.exitCode).toBe(126);
    expect(r.stderrTail).toContain("permission denied");
  });

  it("an empty log after a failed run is flagged as logEmpty (died before writing)", () => {
    writeFileSync(logPath, "");
    const { run } = cannedRun([
      { match: isKickstart, reply: ok },
      { match: isPrint, reply: { code: 0, stdout: printExited(209), stderr: "" } },
    ]);
    const r = verifyFirstRun({ plat: "darwin", darwinTarget: target, stderrLogPath: logPath, hooks: { run } });
    expect(r.outcome).toBe("run-failed");
    expect(r.logEmpty).toBe(true);
    expect(r.stderrTail).toBe("");
  });

  it("no completed run inside the budget → timeout, NOT success and NOT failure", () => {
    const { run } = cannedRun([
      { match: isKickstart, reply: ok },
      { match: isPrint, reply: { code: 0, stdout: PRINT_RUNNING, stderr: "" } },
    ]);
    // Fake clock: each now() call advances 5s, so the 12s budget lapses after
    // a few polls without any real sleeping.
    let t = 0;
    const r = verifyFirstRun({
      plat: "darwin",
      darwinTarget: target,
      stderrLogPath: logPath,
      hooks: { run, sleep: () => {}, now: () => (t += 5_000) },
    });
    expect(r.verified).toBe(false);
    expect(r.outcome).toBe("timeout");
    expect(r.exitCode).toBeNull();
  });

  it("launchctl unspawnable → manager-unavailable (its own state, not run-failed)", () => {
    const { run } = cannedRun([{ match: isKickstart, reply: { code: null, stdout: "", stderr: "" } }]);
    const r = verifyFirstRun({ plat: "darwin", darwinTarget: target, stderrLogPath: logPath, hooks: { run } });
    expect(r.verified).toBe(false);
    expect(r.outcome).toBe("manager-unavailable");
  });

  it("kickstart rejected → start-failed with the command's own diagnostics", () => {
    const { run } = cannedRun([
      { match: isKickstart, reply: { code: 113, stdout: "", stderr: "Could not find service\n" } },
    ]);
    const r = verifyFirstRun({ plat: "darwin", darwinTarget: target, stderrLogPath: logPath, hooks: { run } });
    expect(r.verified).toBe(false);
    expect(r.outcome).toBe("start-failed");
    expect(r.detail).toContain("Could not find service");
  });
});

// ─── verifyFirstRun: linux (blocking start + single show read) ──────────────

describe("verifyFirstRun (linux)", () => {
  const unit = "flair-test.service";

  it("blocking start exits 0 → verified, with the recorded status from show", () => {
    const { run, calls } = cannedRun([
      { match: isStart, reply: ok },
      { match: isShow, reply: { code: 0, stdout: "ExecMainStatus=0\nResult=success\n", stderr: "" } },
    ]);
    const r = verifyFirstRun({ plat: "linux", linuxServiceUnit: unit, stderrLogPath: logPath, hooks: { run } });
    expect(r.verified).toBe(true);
    expect(r.outcome).toBe("success");
    expect(r.exitCode).toBe(0);
    // Single show read after the blocking start — no polling on linux.
    expect(calls.filter(isShow).length).toBe(1);
  });

  it("start fails → run-failed with ExecMainStatus as the exit code", () => {
    writeFileSync(logPath, "Error: something broke\n");
    const { run } = cannedRun([
      { match: isStart, reply: { code: 1, stdout: "", stderr: "Job for flair-test.service failed.\n" } },
      { match: isShow, reply: { code: 0, stdout: "ExecMainStatus=126\nResult=exit-code\n", stderr: "" } },
    ]);
    const r = verifyFirstRun({ plat: "linux", linuxServiceUnit: unit, stderrLogPath: logPath, hooks: { run } });
    expect(r.verified).toBe(false);
    expect(r.outcome).toBe("run-failed");
    expect(r.exitCode).toBe(126);
    expect(r.stderrTail).toContain("something broke");
  });

  it("no session bus → manager-unavailable, never run-failed", () => {
    const { run } = cannedRun([
      { match: isStart, reply: { code: 1, stdout: "", stderr: "Failed to connect to bus: No medium found\n" } },
    ]);
    const r = verifyFirstRun({ plat: "linux", linuxServiceUnit: unit, stderrLogPath: logPath, hooks: { run } });
    expect(r.verified).toBe(false);
    expect(r.outcome).toBe("manager-unavailable");
  });

  it("start killed by its timeout (null code) → timeout — the run may still be going", () => {
    const { run } = cannedRun([
      { match: isStart, reply: { code: null, stdout: "", stderr: "partial\n" } },
    ]);
    const r = verifyFirstRun({ plat: "linux", linuxServiceUnit: unit, stderrLogPath: logPath, hooks: { run } });
    expect(r.verified).toBe(false);
    expect(r.outcome).toBe("timeout");
  });
});
