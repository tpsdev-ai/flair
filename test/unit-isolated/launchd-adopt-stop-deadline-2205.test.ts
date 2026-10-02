import { afterAll, expect, mock, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../helpers/temp-dir.ts";

const home = tempDir("flair-adopt-deadline-");
const dataDir = join(home, ".flair", "data");
const agentsDir = join(home, "Library", "LaunchAgents");
mkdirSync(dataDir, { recursive: true });
mkdirSync(agentsDir, { recursive: true });
chmodSync(dataDir, 0o700);
const pid = 424242;
const port = 19999;
const started = Date.now();
const commands: string[] = [];
const signals: unknown[] = [];
const savedHome = process.env.HOME;
const savedPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
process.env.HOME = home;
Object.defineProperty(process, "platform", { value: "darwin" });
mock.module("node:os", () => ({ ...require("node:os"), homedir: () => home }));
mock.module("../../src/lib/process-start-time.js", () => ({
  readProcessStartTimeMs: () => started,
  readProcessStartSecondMs: () => started,
}));
mock.module("node:child_process", () => ({
  ...childProcess,
  execSync: (cmd: string) => {
    commands.push(cmd);
    if (cmd.startsWith("lsof ")) return String(pid);
    if (cmd.startsWith("launchctl print ")) {
      throw Object.assign(new Error("absent"), { status: 113, stderr: "Could not find service" });
    }
    throw new Error(`unexpected command: ${cmd}`);
  },
  execFileSync: (cmd: string) => {
    if (cmd === "lsof") return String(pid);
    if (cmd === "ps") return `node /fixture/node_modules/harper/dist/bin/harper.js run .`;
    throw new Error(`unexpected execFileSync: ${cmd}`);
  },
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
    signals.push(signal);
    rmSync(join(dataDir, "hdb.pid"), { force: true });
  }
  return true;
}) as typeof process.kill);
const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () =>
  new Response(JSON.stringify({ ok: true, version: "0.0.0", searchReady: true }), {
    headers: { "content-type": "application/json" },
  })) as unknown as typeof fetch);
const { buildRepairPlist, launchdLabel, launchdPlistPath, repairLaunchdManagement } = await import("../../src/cli.ts");

afterAll(() => {
  kill.mockRestore();
  fetchSpy.mockRestore();
  Object.defineProperty(process, "platform", savedPlatform);
  if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
});

test("a direct process that survives SIGTERM returns its exit-wait failure within the stop budget", async () => {
  writeFileSync(join(dataDir, "hdb.pid"), String(pid));
  writeFileSync(join(dataDir, "flair-daemon.json"), JSON.stringify({ pid, port, startTimeMs: started, flairVersion: "test" }));
  const config = { rootPath: dataDir, http: { port }, operationsApi: { network: { port: port - 1 } } };
  writeFileSync(join(dataDir, "harper-config.yaml"), JSON.stringify(config));
  writeFileSync(join(home, ".flair", "admin-pass"), "fixture-pass\n", { mode: 0o600 });
  const plistPath = launchdPlistPath(launchdLabel(dataDir), agentsDir);
  const plist = buildRepairPlist(dataDir, config);
  writeFileSync(plistPath, plist);
  let elapsed = 0;
  const realSetTimeout = globalThis.setTimeout;
  const now = spyOn(Date, "now").mockImplementation(() => started + elapsed);
  const sleep = spyOn(globalThis, "setTimeout").mockImplementation(((fn: (...args: any[]) => void, ms: number, ...args: any[]) => {
    if (ms === 500 || ms === 250) {
      elapsed += ms;
      return realSetTimeout(fn, 0, ...args);
    }
    return realSetTimeout(fn, ms, ...args);
  }) as typeof setTimeout);
  try {
    const result = await repairLaunchdManagement(dataDir, port);
    expect(elapsed, "the stop must report before the doctor's 60s child deadline").toBeLessThan(20_000);
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") throw new Error(JSON.stringify(result));
    expect(result.detail).toContain(`waiting for direct Harper process ${pid}`);
    expect(result.detail).toContain("to exit after SIGTERM; it is still alive");
    expect(result.detail).toContain(dataDir);
    expect(result.remedy?.join(" ")).toContain("after it exits, run flair doctor --fix");
    expect(signals).toEqual(["SIGTERM"]);
    expect(commands.some((cmd) => /launchctl (bootstrap|kickstart|bootout)/.test(cmd))).toBe(false);
    expect(readFileSync(plistPath, "utf8")).toBe(plist);
  } finally {
    sleep.mockRestore();
    now.mockRestore();
  }
});
