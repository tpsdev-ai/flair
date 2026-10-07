import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../helpers/temp-dir.ts";
import { classifyDaemonState } from "../../src/lib/daemon-liveness.ts";

let home = tempDir("flair-adopt-deadline-");
let dataDir = join(home, ".flair", "data");
let agentsDir = join(home, "Library", "LaunchAgents");
mkdirSync(dataDir, { recursive: true });
mkdirSync(agentsDir, { recursive: true });
chmodSync(dataDir, 0o700);
const pid = 424242;
const port = 19999;
const started = Date.now();
const commands: string[] = [];
const signals: unknown[] = [];
let elapsed = 0;
let signalled = false;
let exitsOnTerm = false;
let idleJobLoaded = false;
let signalError: string | undefined;
let pidOnTerm: string | undefined;
let pollError: string | undefined;
let goneAtDeadline = false;
let deadlineDuringLiveness = false;
let identityAfterTerm: number | null = started;
let identityReadMs = 0;
let finalProbe: "timeout" | "error" | "garbage" | "self" | "empty" | "whitespace" | "exit1" | "exit1-stderr" | "exit1-stdout" | "exit1-signal" | "exit1-error" | "exit0-error" = "empty";
let healthAfterTerm: "refused" | "hang" | "late-refused" | "refuse-on-abort" = "refused";
let accelerateProbe = false;
let recoveryPortHeld = false;
let spawnCalls = 0;
const identityChecks: number[] = [];
const identityBudgets: number[] = [];
const finalProbeTimeouts: number[] = [];
const healthChecks: number[] = [];
const savedHome = process.env.HOME;
const savedCachePath = process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH;
process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH = join(savedHome!, "bun-cache");
const savedPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
process.env.HOME = home;
Object.defineProperty(process, "platform", { value: "darwin" });
mock.module("node:os", () => ({ ...require("node:os"), homedir: () => home }));
mock.module("../../src/lib/process-start-time.js", () => ({
  readProcessStartTimeMs: (_pid: number, deadline = Infinity) => {
    if (signalled) identityBudgets.push(deadline - Date.now());
    if (Date.now() >= deadline) return null;
    if (signalled) {
      elapsed += Math.min(identityReadMs, deadline - Date.now());
      if (Date.now() >= deadline) return null;
      identityChecks.push(elapsed);
      return identityAfterTerm;
    }
    return started;
  },
  readProcessStartSecondMs: () => started,
}));
mock.module("node:child_process", () => ({
  ...childProcess,
  execSync: (cmd: string) => {
    commands.push(cmd);
    if (cmd.startsWith("lsof ")) return String(pid);
    if (cmd.startsWith("launchctl bootout ")) { idleJobLoaded = false; return ""; }
    if (cmd.startsWith("launchctl print ")) {
      if (idleJobLoaded && cmd.endsWith(launchdLabel(dataDir))) return "";
      throw Object.assign(new Error("absent"), { status: 113, stderr: "Could not find service" });
    }
    throw new Error(`unexpected command: ${cmd}`);
  },
  execFileSync: (cmd: string, _args: string[], opts: { timeout: number }) => {
    if (cmd === "lsof") {
      if (!signalled) return String(pid);
      finalProbeTimeouts.push(opts.timeout);
      if (finalProbe === "timeout") {
        elapsed += opts.timeout;
        throw Object.assign(new Error("probe timeout"), { code: "ETIMEDOUT", signal: "SIGKILL" });
      }
      if (finalProbe === "error") throw Object.assign(new Error("failed"), { status: 2, stdout: "", stderr: "lsof failed" });
      if (finalProbe === "exit1") throw Object.assign(new Error("no match"), { status: 1, stdout: "", stderr: "" });
      if (finalProbe === "exit1-stderr") throw Object.assign(new Error("failed"), { status: 1, stdout: "", stderr: "lsof failed" });
      if (finalProbe === "exit1-stdout") throw Object.assign(new Error("failed"), { status: 1, stdout: String(pid), stderr: "" });
      if (finalProbe === "exit1-signal") throw Object.assign(new Error("failed"), { status: 1, stdout: "", stderr: "", signal: "SIGKILL" });
      if (finalProbe === "exit1-error") throw Object.assign(new Error("failed"), { status: 1, stdout: "", stderr: "", error: new Error("failed") });
      if (finalProbe === "exit0-error") throw Object.assign(new Error("failed"), { status: 0, stdout: "", stderr: "" });
      if (finalProbe === "garbage") return "not a pid";
      if (finalProbe === "self") return String(process.pid);
      if (finalProbe === "whitespace") return " \t\n";
      return "";
    }
    if (cmd === "/bin/ps" || cmd === "ps") return `node /fixture/node_modules/harper/dist/bin/harper.js run .`;
    throw new Error(`unexpected execFileSync: ${cmd}`);
  },
  spawn: () => { spawnCalls++; throw new Error("unexpected process spawn"); },
  spawnSync: (cmd: string, args: string[]) => {
    commands.push([cmd, ...args].join(" "));
    if (cmd === "plutil") return { status: 0, stdout: "OK" };
    if (cmd === "launchctl") {
      if (args[0] === "list") return { status: 113, stdout: "" };
      if (args[0] === "print") return { status: 0, stdout: "domain = {}" };
      if (args[0] === "print-disabled") return { status: 0, stdout: "disabled services = {}" };
    }
    throw new Error(`unexpected spawnSync: ${cmd} ${args}`);
  },
}));
const kill = spyOn(process, "kill").mockImplementation(((target: number, signal: unknown) => {
  if (target !== pid) throw Object.assign(new Error("no such process"), { code: "ESRCH" });
  if (signal !== 0) {
    signalled = true;
    signals.push(signal);
    rmSync(join(dataDir, "hdb.pid"), { force: true });
    if (pidOnTerm) writeFileSync(join(dataDir, "hdb.pid"), pidOnTerm);
    if (signalError) throw Object.assign(new Error("signal failed"), { code: signalError });
  } else if (signalled) {
    if (deadlineDuringLiveness) elapsed = 60_000;
    if ((exitsOnTerm && signalError !== "EPERM") || (goneAtDeadline && elapsed >= 60_000)) throw Object.assign(new Error("gone"), { code: "ESRCH" });
    if (pollError) throw Object.assign(new Error("probe failed"), { code: pollError });
  }
  return true;
}) as typeof process.kill);
const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (_input: unknown, options: RequestInit) => {
  if (signalled) {
    healthChecks.push(elapsed);
    if (recoveryPortHeld && elapsed >= 60_000) {
      return new Response(JSON.stringify({ ok: true, version: "0.0.0", searchReady: true, buildCommit: null }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (healthAfterTerm === "refuse-on-abort") {
      return new Promise((_resolve, reject) => options.signal!.addEventListener("abort", () => {
        reject(Object.assign(new Error("refused"), { cause: { code: "ECONNREFUSED" } }));
      }, { once: true }));
    }
    if (healthAfterTerm === "hang" && elapsed < 60_000) {
      accelerateProbe = true;
      return { json: () => new Promise(() => {}), status: 200 };
    }
    if (healthAfterTerm === "late-refused" && elapsed < 59_750) elapsed += 59_750;
    throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
  }
  return new Response(JSON.stringify({ ok: true, version: "0.0.0", searchReady: true }), {
    headers: { "content-type": "application/json" },
  });
}) as unknown as typeof fetch);
const { buildRepairPlist, launchdLabel, launchdPlistPath, repairLaunchdManagement, program, gatherDaemonEvidence } = await import("../../src/cli.ts");

afterAll(() => {
  kill.mockRestore();
  fetchSpy.mockRestore();
  Object.defineProperty(process, "platform", savedPlatform);
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  if (savedCachePath === undefined) delete process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH;
  else process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH = savedCachePath;
});

let now: ReturnType<typeof spyOn>;
let sleep: ReturnType<typeof spyOn>;
let plistPath: string;
let plist: string;
beforeEach(() => {
  home = tempDir("s");
  dataDir = join(home, ".flair", "data");
  agentsDir = join(home, "Library", "LaunchAgents");
  process.env.HOME = home;
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(agentsDir, { recursive: true });
  chmodSync(dataDir, 0o700);
  elapsed = 0;
  signalled = false;
  exitsOnTerm = false;
  idleJobLoaded = false;
  signalError = pollError = pidOnTerm = undefined;
  goneAtDeadline = false;
  deadlineDuringLiveness = false;
  identityAfterTerm = started;
  identityReadMs = 0;
  finalProbe = "empty";
  healthAfterTerm = "refused";
  accelerateProbe = false;
  recoveryPortHeld = false;
  spawnCalls = 0;
  for (const items of [commands, signals, identityChecks, identityBudgets, finalProbeTimeouts, healthChecks]) items.length = 0;
  writeFileSync(join(dataDir, "hdb.pid"), String(pid));
  writeFileSync(join(dataDir, "flair-daemon.json"), JSON.stringify({ pid, port, startTimeMs: started, flairVersion: "test" }));
  const config = { rootPath: dataDir, http: { port }, operationsApi: { network: { port: port - 1 } } };
  writeFileSync(join(dataDir, "harper-config.yaml"), JSON.stringify(config));
  writeFileSync(join(home, ".flair", "admin-pass"), "fixture-pass\n", { mode: 0o600 });
  plistPath = launchdPlistPath(launchdLabel(dataDir), agentsDir);
  plist = buildRepairPlist(dataDir, config);
  writeFileSync(plistPath, plist);
  const realSetTimeout = globalThis.setTimeout;
  now = spyOn(Date, "now").mockImplementation(() => started + elapsed);
  sleep = spyOn(globalThis, "setTimeout").mockImplementation(((fn: (...args: any[]) => void, ms: number, ...args: any[]) => {
    if (ms <= 2000 || accelerateProbe) {
      return realSetTimeout(() => { elapsed += ms; fn(...args); }, 0);
    }
    return realSetTimeout(fn, ms, ...args);
  }) as typeof setTimeout);
});
afterEach(() => { sleep.mockRestore(); now.mockRestore(); process.env.HOME = savedHome; });

async function failedStop() {
  const result = await repairLaunchdManagement(dataDir, port);
  expect(result.kind).toBe("failed");
  if (result.kind !== "failed") throw new Error(JSON.stringify(result));
  expect(commands.some((cmd) => /launchctl (bootstrap|kickstart|bootout)/.test(cmd))).toBe(false);
  expect(readFileSync(plistPath, "utf8")).toBe(plist);
  return result;
}

test("a direct process surviving SIGTERM consumes only the shared 60s stop deadline", async () => {
  identityReadMs = 100;
  const result = await failedStop();
  expect(elapsed).toBe(60_000);
  expect(result.detail).toContain(`waiting for direct Harper process ${pid}`);
  expect(result.detail).toContain("not observed to exit before the deadline");
  expect(result.detail).toContain("SIGTERM sent");
  expect(result.detail).toContain(dataDir);
  expect(spawnCalls).toBe(0);
  expect(identityChecks).toEqual([100]);
  expect(identityBudgets).toEqual([2_000]);
  expect(result.detail).toContain(`identity: verified, observed at ${new Date(started + 100).toISOString()}`);
  expect(healthChecks).toEqual([]);
  expect(finalProbeTimeouts).toEqual([]);
  expect(signals).toEqual(["SIGTERM"]);
  expect(existsSync(join(dataDir, "hdb.pid"))).toBe(false);
});

test("a slow identity read is bounded before the shared deadline", async () => {
  identityReadMs = 10_000;
  const result = await failedStop();
  expect(spawnCalls).toBe(0);
  expect(identityBudgets).toEqual([2_000]);
  expect(identityChecks).toEqual([]);
  expect(result.detail).toContain(`identity: unverified, observed at ${new Date(started + 2_000).toISOString()}`);
  expect(elapsed).toBe(60_000);
});

for (const code of ["EPERM", "EINVAL"]) {
  test(`signal and liveness ${code} are not proof of exit`, async () => {
    signalError = pollError = code;
    identityAfterTerm = null;
    const result = await failedStop();
    expect(elapsed).toBe(60_000);
    expect(result.detail).toContain(`SIGTERM failed (${code})`);
    expect(result.detail).toContain("identity: unverified");
    expect(spawnCalls).toBe(0);
    expect(result.detail).toContain(`liveness: ${code === "EPERM" ? "eperm" : "unknown"}`);
    expect(identityChecks).toEqual([0]);
    expect(healthChecks).toEqual([]);
  });
}

test("ESRCH at the deadline is reported without claiming the process is still alive", async () => {
  goneAtDeadline = true;
  identityAfterTerm = null;
  const result = await failedStop();
  expect(result.detail).toContain("liveness: gone");
  expect(spawnCalls).toBe(0);
  expect(result.detail).not.toContain("still alive");
  expect(elapsed).toBe(60_000);
  expect(identityChecks).toEqual([0]);
  expect(healthChecks).toEqual([]);
});

test("a final listener probe timeout is a named stop failure", async () => {
  exitsOnTerm = true;
  finalProbe = "timeout";
  const result = await failedStop();
  expect(result.detail).toContain("Final listener probe failed");
  expect(result.detail).toContain("ETIMEDOUT");
  expect(finalProbeTimeouts).toEqual([2_000]);
});

for (const outcome of ["error", "garbage", "self", "empty", "whitespace", "exit1-stderr", "exit1-stdout", "exit1-signal", "exit1-error", "exit0-error"] as const) {
  test(`the final listener probe rejects ${outcome}`, async () => {
    exitsOnTerm = true;
    finalProbe = outcome;
    const result = await failedStop();
    expect(result.detail).toContain(outcome === "self" ? "port still occupied" : "Final listener probe failed");
  });
}

for (const outcome of ["timeout", "error", "garbage"] as const) {
  test(`a final listener probe ${outcome} after exit attempts a restart when the recovery port probe refuses`, async () => {
    exitsOnTerm = true;
    finalProbe = outcome;
    const result = await failedStop();
    expect(signals).toEqual(["SIGTERM"]);
    expect(spawnCalls).toBe(1);
    expect(result.detail).toContain("restarting it directly FAILED");
    expect(result.detail).toContain("Flair is DOWN");
    expect(result.remedy).toEqual(["flair start"]);
  });
}

test("a stop failure with no exit confirmed before the deadline attempts no restart", async () => {
  const result = await failedStop();
  expect(result.detail).toContain("not observed to exit before the deadline");
  expect(spawnCalls).toBe(0);
  expect(result.detail).not.toMatch(/restart/i);
});

test("the final listener probe gets only the shared deadline's remaining time", async () => {
  exitsOnTerm = true;
  healthAfterTerm = "late-refused";
  finalProbe = "timeout";
  const result = await failedStop();
  expect(spawnCalls).toBe(1);
  expect(result.detail).toContain("restarting it directly FAILED");
  expect(result.detail).toContain("Flair is DOWN");
  expect(result.remedy).toEqual(["flair start"]);
  expect(healthChecks).toEqual([0, 60_000]);
  expect(finalProbeTimeouts).toEqual([250]);
  expect(elapsed).toBe(60_000);
});

test("recovery refuses a restart when its port check finds a listener after the stop deadline", async () => {
  exitsOnTerm = true;
  healthAfterTerm = "late-refused";
  finalProbe = "timeout";
  recoveryPortHeld = true;
  const result = await failedStop();
  expect(elapsed).toBe(60_000);
  expect(spawnCalls).toBe(0);
  expect(result.detail).toContain(`port ${port} is not free (ok)`);
  expect(result.detail).toContain("Flair was NOT restarted directly");
  expect(result.remedy).toEqual(["flair status", "flair start"]);
});

test("the stop path's wait for a hanging health body is bounded by the shared deadline", async () => {
  exitsOnTerm = true;
  healthAfterTerm = "hang";
  accelerateProbe = true;
  const result = await failedStop();
  expect(result.detail).toContain("last health probe: unreachable");
  expect(spawnCalls).toBe(1);
  expect(result.detail).toContain("Flair is DOWN");
  expect(result.remedy).toEqual(["flair start"]);
  expect(elapsed).toBe(60_000);
  expect(finalProbeTimeouts).toEqual([]);
});

test("a clean exit-status-1 no-match allows the replacement load attempt", async () => {
  exitsOnTerm = true;
  finalProbe = "exit1";
  await repairLaunchdManagement(dataDir, port);
  expect(commands.some((cmd) => /launchctl bootstrap/.test(cmd))).toBe(true);
});

test("SIGTERM ESRCH permits the remaining probes without claiming delivery", async () => {
  signalError = "ESRCH";
  exitsOnTerm = true;
  finalProbe = "timeout";
  const result = await failedStop();
  expect(result.detail).toContain("Final listener probe failed");
  expect(elapsed).toBe(2_000);
});

test("a stop failure reports that an idle prior launchd job was unloaded", async () => {
  idleJobLoaded = true;
  const result = await repairLaunchdManagement(dataDir, port);
  expect(result.kind).toBe("failed");
  if (result.kind !== "failed") throw new Error(JSON.stringify(result));
  expect(result.detail).toContain("Previously loaded launchd jobs were unloaded");
  expect(commands.filter((cmd) => /launchctl bootout/.test(cmd))).toHaveLength(1);
  expect(commands.some((cmd) => /launchctl (bootstrap|kickstart)/.test(cmd))).toBe(false);
  expect(readFileSync(plistPath, "utf8")).toBe(plist);
});

test("a liveness probe reaching the deadline does not start another sleep", async () => {
  deadlineDuringLiveness = true;
  await failedStop();
  expect(spawnCalls).toBe(0);
  expect(elapsed).toBe(60_000);
  expect(sleep.mock.calls.filter((call: unknown[]) => Number(call[1]) <= 500)).toEqual([]);
  expect(identityChecks).toEqual([0]);
});


test("start attempts a replacement after a timed-out stop with no pidfile once the process exits", async () => {
  Object.defineProperty(process, "platform", { value: "linux" });
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    await expect(program.parseAsync(["node", "flair", "stop", "--port", String(port)]))
      .rejects.toThrow(`Process ${pid} did not exit within 60000ms`);
    expect(elapsed).toBe(60_000);
    expect(existsSync(join(dataDir, "hdb.pid"))).toBe(false);
    expect(readFileSync(join(dataDir, "flair-daemon.json"), "utf8")).toContain(String(pid));
    exitsOnTerm = true;
    const evidence = await gatherDaemonEvidence(port, dataDir);
    expect(evidence.pidLiveness).toEqual({ kind: "gone" });
    expect(evidence.health).toEqual({ kind: "refused" });
    await expect(program.parseAsync(["node", "flair", "start", "--port", String(port)]))
      .rejects.toThrow("unexpected process spawn");
  } finally {
    log.mockRestore();
    Object.defineProperty(process, "platform", { value: "darwin" });
  }
});


test("a stop timeout leaves an existing replacement pid record alone", async () => {
  pidOnTerm = "424243";
  await failedStop();
  expect(readFileSync(join(dataDir, "hdb.pid"), "utf8")).toBe(pidOnTerm);
});

for (const code of ["EPERM", "EINVAL"]) {
  test(`ordinary stop retains the pid when liveness reports ${code}`, async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    pollError = code;
    pidOnTerm = String(pid);
    try {
      await expect(program.parseAsync(["node", "flair", "stop", "--port", String(port)]))
        .rejects.toThrow(`Process ${pid} did not exit within 60000ms`);
      expect(readFileSync(join(dataDir, "hdb.pid"), "utf8")).toBe(String(pid));
      expect(readFileSync(join(dataDir, "flair-daemon.json"), "utf8")).toContain(String(pid));
    } finally {
      Object.defineProperty(process, "platform", { value: "darwin" });
    }
  });
}


test("ordinary health probing retains ECONNREFUSED from fetch's abort handler", async () => {
  signalled = exitsOnTerm = true;
  healthAfterTerm = "refuse-on-abort";
  const evidence = await gatherDaemonEvidence(port, dataDir);
  expect(evidence.pidLiveness).toEqual({ kind: "gone" });
  expect(evidence.health).toEqual({ kind: "refused" });
});

for (const [code, expected] of [[undefined, "DISAGREEMENT"], ["EPERM", "DISAGREEMENT"], ["EINVAL", "UNKNOWN"]] as const) {
  test(`missing pidfile with last-known pid liveness ${code ?? "alive"} yields ${expected}`, async () => {
    signalled = true;
    pollError = code;
    rmSync(join(dataDir, "hdb.pid"));
    const evidence = await gatherDaemonEvidence(port, dataDir);
    expect(evidence.health).toEqual({ kind: "refused" });
    expect(classifyDaemonState(evidence, { port, dataDir }).state).toBe(expected);
    expect(existsSync(join(dataDir, "hdb.pid"))).toBe(false);
  });
}

test("missing pidfile with an unreadable sidecar yields UNKNOWN", async () => {
  rmSync(join(dataDir, "hdb.pid"));
  writeFileSync(join(dataDir, "flair-daemon.json"), "invalid");
  signalled = true;
  const evidence = await gatherDaemonEvidence(port, dataDir);
  expect(evidence.health).toEqual({ kind: "refused" });
  expect(classifyDaemonState(evidence, { port, dataDir }).state).toBe("UNKNOWN");
});
