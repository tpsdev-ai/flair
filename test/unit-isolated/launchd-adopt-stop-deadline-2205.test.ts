import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../helpers/temp-dir.ts";

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
let pollError: string | undefined;
let goneAtDeadline = false;
let deadlineDuringLiveness = false;
let identityAtDeadline: number | null = started;
let finalProbe: "timeout" | "error" | "garbage" | "self" | "empty" | "exit1" = "empty";
let healthAfterTerm: "refused" | "hang" | "late-refused" = "refused";
let accelerateProbe = false;
const identityChecks: number[] = [];
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
  readProcessStartTimeMs: () => {
    if (signalled && elapsed >= 60_000) {
      identityChecks.push(elapsed);
      return identityAtDeadline;
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
      if (finalProbe === "garbage") return "not a pid";
      if (finalProbe === "self") return String(process.pid);
      return "";
    }
    if (cmd === "ps") return `node /fixture/node_modules/harper/dist/bin/harper.js run .`;
    throw new Error(`unexpected execFileSync: ${cmd}`);
  },
  spawn: () => { throw new Error("unexpected process spawn"); },
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
    if (signalError) throw Object.assign(new Error("signal failed"), { code: signalError });
  } else if (signalled) {
    if (deadlineDuringLiveness) elapsed = 60_000;
    if ((exitsOnTerm && signalError !== "EPERM") || (goneAtDeadline && elapsed >= 60_000)) throw Object.assign(new Error("gone"), { code: "ESRCH" });
    if (pollError) throw Object.assign(new Error("probe failed"), { code: pollError });
  }
  return true;
}) as typeof process.kill);
const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
  if (signalled) {
    healthChecks.push(elapsed);
    if (healthAfterTerm === "hang") {
      accelerateProbe = true;
      return { json: () => new Promise(() => {}), status: 200 };
    }
    if (healthAfterTerm === "late-refused") elapsed += 59_750;
    throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
  }
  return new Response(JSON.stringify({ ok: true, version: "0.0.0", searchReady: true }), {
    headers: { "content-type": "application/json" },
  });
}) as unknown as typeof fetch);
const { buildRepairPlist, launchdLabel, launchdPlistPath, repairLaunchdManagement } = await import("../../src/cli.ts");

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
  home = tempDir("flair-adopt-deadline-");
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
  signalError = pollError = undefined;
  goneAtDeadline = false;
  deadlineDuringLiveness = false;
  identityAtDeadline = started;
  finalProbe = "empty";
  healthAfterTerm = "refused";
  accelerateProbe = false;
  for (const items of [commands, signals, identityChecks, finalProbeTimeouts, healthChecks]) items.length = 0;
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
  const result = await failedStop();
  expect(elapsed).toBe(60_000);
  expect(result.detail).toContain(`waiting for direct Harper process ${pid}`);
  expect(result.detail).toContain("not observed to exit before the deadline");
  expect(result.detail).toContain("SIGTERM sent");
  expect(result.detail).toContain(dataDir);
  expect(identityChecks).toEqual([60_000]);
  expect(healthChecks).toEqual([]);
  expect(finalProbeTimeouts).toEqual([]);
  expect(signals).toEqual(["SIGTERM"]);
});

for (const code of ["EPERM", "EINVAL"]) {
  test(`signal and liveness ${code} are not proof of exit`, async () => {
    signalError = pollError = code;
    identityAtDeadline = null;
    const result = await failedStop();
    expect(elapsed).toBe(60_000);
    expect(result.detail).toContain(`SIGTERM failed (${code})`);
    expect(result.detail).toContain("identity: unverified");
    expect(result.detail).toContain(`liveness: ${code === "EPERM" ? "eperm" : "unknown"}`);
    expect(identityChecks).toEqual([60_000]);
    expect(healthChecks).toEqual([]);
  });
}

test("ESRCH at the deadline is reported without claiming the process is still alive", async () => {
  goneAtDeadline = true;
  identityAtDeadline = null;
  const result = await failedStop();
  expect(result.detail).toContain("liveness: gone");
  expect(result.detail).not.toContain("still alive");
  expect(elapsed).toBe(60_000);
  expect(identityChecks).toEqual([60_000]);
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

for (const outcome of ["error", "garbage", "self"] as const) {
  test(`the final listener probe rejects ${outcome}`, async () => {
    exitsOnTerm = true;
    finalProbe = outcome;
    const result = await failedStop();
    expect(result.detail).toContain(outcome === "self" ? "port still occupied" : "Final listener probe failed");
  });
}

test("the final listener probe gets only the shared deadline's remaining time", async () => {
  exitsOnTerm = true;
  healthAfterTerm = "late-refused";
  finalProbe = "timeout";
  await failedStop();
  expect(finalProbeTimeouts).toEqual([250]);
  expect(elapsed).toBe(60_000);
});

test("a hanging health response body cannot outlive the shared deadline", async () => {
  exitsOnTerm = true;
  healthAfterTerm = "hang";
  accelerateProbe = true;
  const result = await failedStop();
  expect(result.detail).toContain("last health probe: unreachable");
  expect(elapsed).toBe(60_000);
  expect(finalProbeTimeouts).toEqual([]);
});

for (const noListener of ["empty", "exit1"] as const) {
  test(`a successful ${noListener} listener result allows the replacement load attempt`, async () => {
    exitsOnTerm = true;
    finalProbe = noListener;
    await repairLaunchdManagement(dataDir, port);
    expect(commands.some((cmd) => /launchctl bootstrap/.test(cmd))).toBe(true);
  });
}

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
  expect(elapsed).toBe(60_000);
  expect(sleep.mock.calls.filter((call: unknown[]) => Number(call[1]) <= 500)).toEqual([]);
  expect(identityChecks).toEqual([60_000]);
});
