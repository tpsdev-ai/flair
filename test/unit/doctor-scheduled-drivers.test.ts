/**
 * doctor-scheduled-drivers.test.ts — unit tests for the flair#1278 doctor
 * section: scheduler/driver liveness where operators actually look.
 *
 * Two units under test, both in src/lib/scheduler-platform.ts:
 *   - queryLastExitStatus(): reads how a scheduled job's most recent run
 *     ended, through the service manager (reusing the #1282 parsers).
 *   - describeScheduledDriverFinding(): the pure verdict logic the doctor
 *     section renders — enabled-healthy / enabled-last-run-failed /
 *     not-enabled / not-loaded / unverified.
 *
 * SAFETY: every queryLastExitStatus call injects `run`, so no test spawns a
 * real launchctl or systemctl and none touches the user's service-manager
 * domain (same idiom as scheduler-first-run-verify.test.ts).
 */

import { describe, it, expect } from "bun:test";
import {
  queryLastExitStatus,
  describeScheduledDriverFinding,
  describeExitCode,
  type LastExitStatus,
  type ScheduledDriverFacts,
  type SpawnReport,
} from "../../src/lib/scheduler-platform.ts";
import * as render from "../../src/render.ts";

// ─── queryLastExitStatus: darwin ────────────────────────────────────────────

const DARWIN_TARGET = "gui/501/dev.flair.test.job";

function darwinQuery(reply: SpawnReport) {
  const calls: string[][] = [];
  const result = queryLastExitStatus({
    plat: "darwin",
    darwinTarget: DARWIN_TARGET,
    run: (cmd) => {
      calls.push(cmd);
      return reply;
    },
  });
  return { result, calls };
}

const PRINT_FAILED_209 = "gui/501/dev.flair.test.job = {\n\tstate = waiting\n\tlast exit code = 209\n}\n";
const PRINT_EXIT_0 = "gui/501/dev.flair.test.job = {\n\tstate = waiting\n\tlast exit code = 0\n}\n";
const PRINT_RUNNING = "gui/501/dev.flair.test.job = {\n\tstate = running\n\tpid = 4242\n}\n";
const PRINT_NEVER = "gui/501/dev.flair.test.job = {\n\tstate = waiting\n\tlast exit code = (never exited)\n}\n";

describe("queryLastExitStatus — darwin", () => {
  it("asks launchctl print for exactly the given target", () => {
    const { calls } = darwinQuery({ code: 0, stdout: PRINT_EXIT_0, stderr: "" });
    expect(calls).toEqual([["launchctl", "print", DARWIN_TARGET]]);
  });

  it("reads a recorded failing exit back out of launchctl print", () => {
    const { result } = darwinQuery({ code: 0, stdout: PRINT_FAILED_209, stderr: "" });
    expect(result.state).toBe("recorded");
    expect(result.exitCode).toBe(209);
  });

  it("reads a recorded exit 0", () => {
    const { result } = darwinQuery({ code: 0, stdout: PRINT_EXIT_0, stderr: "" });
    expect(result.state).toBe("recorded");
    expect(result.exitCode).toBe(0);
  });

  it("reports an in-flight run as 'running', not as a recorded exit", () => {
    const { result } = darwinQuery({ code: 0, stdout: PRINT_RUNNING, stderr: "" });
    expect(result.state).toBe("running");
    expect(result.exitCode).toBeNull();
  });

  it("reports a job that never completed a run as 'never-ran'", () => {
    const { result } = darwinQuery({ code: 0, stdout: PRINT_NEVER, stderr: "" });
    expect(result.state).toBe("never-ran");
    expect(result.exitCode).toBeNull();
  });

  it("reports 'unavailable' when launchctl itself could not run", () => {
    const { result } = darwinQuery({ code: null, stdout: "", stderr: "" });
    expect(result.state).toBe("unavailable");
  });

  it("reports 'unavailable' when launchctl print fails (job not loaded)", () => {
    const { result } = darwinQuery({ code: 3, stdout: "", stderr: "Could not find service" });
    expect(result.state).toBe("unavailable");
    expect(result.detail).toContain("code 3");
  });

  it("requires darwinTarget on darwin", () => {
    expect(() => queryLastExitStatus({ plat: "darwin", run: () => ({ code: 0, stdout: "", stderr: "" }) })).toThrow(/darwinTarget/);
  });
});

// ─── queryLastExitStatus: linux ─────────────────────────────────────────────

const LINUX_UNIT = "flair-test.service";

function linuxQuery(reply: SpawnReport) {
  const calls: string[][] = [];
  const result = queryLastExitStatus({
    plat: "linux",
    linuxServiceUnit: LINUX_UNIT,
    run: (cmd) => {
      calls.push(cmd);
      return reply;
    },
  });
  return { result, calls };
}

function show(props: { status: number; result: string; ts: number }): string {
  return `ExecMainStatus=${props.status}\nResult=${props.result}\nExecMainExitTimestampMonotonic=${props.ts}\n`;
}

describe("queryLastExitStatus — linux", () => {
  it("asks systemctl show for the SERVICE unit with the exit properties", () => {
    const { calls } = linuxQuery({ code: 0, stdout: show({ status: 0, result: "success", ts: 5 }), stderr: "" });
    expect(calls).toEqual([
      ["systemctl", "--user", "show", LINUX_UNIT, "--property=ExecMainStatus,Result,ExecMainExitTimestampMonotonic"],
    ]);
  });

  it("reads a recorded failing exit (Result carried into the detail)", () => {
    const { result } = linuxQuery({ code: 0, stdout: show({ status: 126, result: "exit-code", ts: 123456 }), stderr: "" });
    expect(result.state).toBe("recorded");
    expect(result.exitCode).toBe(126);
    expect(result.detail).toContain("Result=exit-code");
  });

  it("reads a recorded exit 0", () => {
    const { result } = linuxQuery({ code: 0, stdout: show({ status: 0, result: "success", ts: 998877 }), stderr: "" });
    expect(result.state).toBe("recorded");
    expect(result.exitCode).toBe(0);
  });

  it("NEVER-RAN TRAP: a unit with no completed run reports systemd's property defaults (ExecMainStatus=0, Result=success) — must read as 'never-ran', not as a passing run", () => {
    const { result } = linuxQuery({ code: 0, stdout: show({ status: 0, result: "success", ts: 0 }), stderr: "" });
    expect(result.state).toBe("never-ran");
    expect(result.exitCode).toBeNull();
  });

  it("reports 'unavailable' when there is no session bus", () => {
    const { result } = linuxQuery({ code: 1, stdout: "", stderr: "Failed to connect to bus: No medium found" });
    expect(result.state).toBe("unavailable");
  });

  it("reports 'unavailable' when systemctl itself could not run", () => {
    const { result } = linuxQuery({ code: null, stdout: "", stderr: "" });
    expect(result.state).toBe("unavailable");
  });

  it("reports 'unavailable' when show fails outright", () => {
    const { result } = linuxQuery({ code: 4, stdout: "", stderr: "Unit escaped the namespace" });
    expect(result.state).toBe("unavailable");
    expect(result.detail).toContain("code 4");
  });

  it("requires linuxServiceUnit on linux", () => {
    expect(() => queryLastExitStatus({ plat: "linux", run: () => ({ code: 0, stdout: "", stderr: "" }) })).toThrow(/linuxServiceUnit/);
  });
});

// ─── describeScheduledDriverFinding — the doctor section's verdicts ─────────

const LOG_PATH = "/home/op/.flair/logs/federation-sync.stderr.log";

function facts(overrides: Partial<ScheduledDriverFacts> = {}): ScheduledDriverFacts {
  return {
    label: "Federation sync driver",
    enableCommand: "flair federation sync enable",
    statusCommand: "flair federation sync status",
    installed: true,
    active: true,
    lastExit: { state: "recorded", exitCode: 0, detail: "launchctl print → last exit code = 0" },
    stderrLogPath: LOG_PATH,
    ...overrides,
  };
}

const recorded = (exitCode: number): LastExitStatus => ({
  state: "recorded",
  exitCode,
  detail: `launchctl print → last exit code = ${exitCode}`,
});

describe("describeScheduledDriverFinding — enabled and healthy", () => {
  it("installed + loaded + last run exit 0 → healthy, pass marker, no issue", () => {
    const f = describeScheduledDriverFinding(facts());
    expect(f.state).toBe("healthy");
    expect(f.icon).toBe("ok");
    expect(f.isIssue).toBe(false);
    expect(f.message).toContain("exit 0");
  });

  it("a run in flight right now is healthy, not a failure", () => {
    const f = describeScheduledDriverFinding(facts({ lastExit: { state: "running", exitCode: null, detail: "a run is in flight" } }));
    expect(f.state).toBe("healthy");
    expect(f.icon).toBe("ok");
    expect(f.isIssue).toBe(false);
  });

  it("loaded with no completed run on record yet is healthy but says so explicitly (no silent pass on the run dimension)", () => {
    const f = describeScheduledDriverFinding(facts({ lastExit: { state: "never-ran", exitCode: null, detail: "no completed run recorded" } }));
    expect(f.state).toBe("healthy");
    expect(f.isIssue).toBe(false);
    expect(f.message).toContain("no completed run");
    // Must NOT claim a run outcome it never observed.
    expect(f.message).not.toContain("exit 0");
  });
});

describe("describeScheduledDriverFinding — enabled, last run failed (degraded)", () => {
  it("renders degraded with the fail marker and counts an issue", () => {
    const f = describeScheduledDriverFinding(facts({ lastExit: recorded(209) }));
    expect(f.state).toBe("degraded");
    expect(f.icon).toBe("error");
    expect(f.isIssue).toBe(true);
    expect(f.message).toContain("DEGRADED");
  });

  it("leads with the named failure class (actor), states what is happening, and names the remedy — embed-verify style", () => {
    const f = describeScheduledDriverFinding(facts({ lastExit: recorded(209) }));
    // Actor: the exit class is named, not a bare number (describeExitCode).
    expect(f.message).toContain(describeExitCode(209));
    expect(f.message).toContain("launchd could not spawn");
    // State: the schedule fires but the runs die — visible in the first detail line.
    expect(f.detail[0]).toContain("loaded and is firing it");
    expect(f.detail[0]).toContain("failing");
    // Remedy: the job's stderr log and the scheduler's own status command.
    const remedy = f.detail.join("\n");
    expect(remedy).toContain(LOG_PATH);
    expect(remedy).toContain("flair federation sync status");
  });

  it("exit 126 (the #1231 stripped-exec-bit incident) names the class too", () => {
    const f = describeScheduledDriverFinding(facts({ lastExit: recorded(126) }));
    expect(f.state).toBe("degraded");
    expect(f.isIssue).toBe(true);
    expect(f.message).toContain("not runnable");
  });
});

describe("describeScheduledDriverFinding — not enabled", () => {
  it("renders 'not enabled' and is never counted as an issue", () => {
    const f = describeScheduledDriverFinding(facts({ installed: false, active: false, lastExit: null }));
    expect(f.state).toBe("not-enabled");
    expect(f.isIssue).toBe(false);
    expect(f.message).toContain("not enabled");
    // The enable command is offered as an opt-in hint, not a "Fix:".
    expect(f.detail.join("\n")).toContain("flair federation sync enable");
  });

  it("is DISTINCT from both the pass marker and the fail marker", () => {
    const notEnabled = describeScheduledDriverFinding(facts({ installed: false, active: false, lastExit: null }));
    const healthy = describeScheduledDriverFinding(facts());
    const degraded = describeScheduledDriverFinding(facts({ lastExit: recorded(209) }));

    // Not the pass icon, not the fail icon — at the enum level...
    expect(notEnabled.icon).not.toBe(healthy.icon);
    expect(notEnabled.icon).not.toBe(degraded.icon);
    // ...and at the level of the actual glyph doctor prints (render.icons is
    // the exact marker table the doctor section renders findings through).
    expect(render.icons[notEnabled.icon]).not.toBe(render.icons.ok);
    expect(render.icons[notEnabled.icon]).not.toBe(render.icons.error);

    // And not pass/fail at the wording level either.
    expect(notEnabled.message).not.toContain("DEGRADED");
    expect(notEnabled.message).not.toContain("loaded");
    expect(notEnabled.message).not.toBe(healthy.message);
    expect(notEnabled.message).not.toBe(degraded.message);
  });
});

describe("describeScheduledDriverFinding — installed but dead or unreadable", () => {
  it("installed but NOT loaded → degraded, fail marker, issue, remedy re-runs enable", () => {
    const f = describeScheduledDriverFinding(facts({ active: false, lastExit: null }));
    expect(f.state).toBe("degraded");
    expect(f.icon).toBe("error");
    expect(f.isIssue).toBe(true);
    expect(f.message).toContain("NOT LOADED");
    expect(f.detail.join("\n")).toContain("flair federation sync enable");
  });

  it("installed, loaded-state unreadable → UNVERIFIED, neither pass nor fail, no issue", () => {
    const f = describeScheduledDriverFinding(facts({ active: null, lastExit: null }));
    expect(f.state).toBe("unverified");
    expect(f.icon).toBe("warn");
    expect(f.isIssue).toBe(false);
    expect(f.message).toContain("UNVERIFIED");
  });

  it("loaded but last-run status unreadable → unverified, not a pass (an unread check must not look green)", () => {
    const f = describeScheduledDriverFinding(facts({ lastExit: { state: "unavailable", exitCode: null, detail: "launchctl could not be run" } }));
    expect(f.state).toBe("unverified");
    expect(f.icon).toBe("warn");
    expect(f.isIssue).toBe(false);
    expect(f.message).toContain("could not be read");
    // The mechanical cause and the follow-up command both surface.
    const detail = f.detail.join("\n");
    expect(detail).toContain("launchctl could not be run");
    expect(detail).toContain("flair federation sync status");
  });
});
