/** Launchd stop verifies exit before attempting confirmed-dead sidecar cleanup. */
import { atomicSignalWriterSource } from "../helpers/atomic-signal-source.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launchdLabel, launchdPlistPath } from "../../src/cli.ts";

const repoRoot = resolve(import.meta.dirname, "../..");

describe("launchd stop exit verification", () => {
  let home: string;
  let dataDir: string;
  let shimBin: string;
  let sidecar: string;
  let child: ReturnType<typeof Bun.spawn> | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "f2075-"));
    dataDir = join(home, ".flair", "data");
    mkdirSync(dataDir, { recursive: true });
    const agentsDir = join(home, "Library", "LaunchAgents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(launchdPlistPath(launchdLabel(dataDir), agentsDir), "<plist/>");
    sidecar = join(dataDir, "flair-daemon.json");
    shimBin = join(home, "bin");
    mkdirSync(shimBin);
  });

  afterEach(async () => {
    if (child) {
      child.kill("SIGKILL");
      await child.exited;
      child = undefined;
    }
    rmSync(home, { recursive: true, force: true });
  });

  async function liveHarperHandler(mode: "delayed" | "stays"): Promise<number> {
    const fixture = join(home, "handler.cjs");
    writeFileSync(fixture, `
const fs = require('node:fs');
${atomicSignalWriterSource}
const path = require('node:path');
const env = require(path.join(process.env.HARPER_TEST_ROOT, 'utility/environment/environmentManager.js'));
const run = require(path.join(process.env.HARPER_TEST_ROOT, 'bin/run.js'));
env.setProperty('ROOTPATH', process.env.ROOTPATH);
run.addExitListeners();
const exit = process.exit.bind(process);
process.exit = () => {
  publishSignal(process.env.REMOVED, String(!fs.existsSync(process.env.PIDFILE)));
  ${mode === "delayed" ? "setTimeout(() => exit(0), 350);" : ""}
};
fs.writeFileSync(process.env.PIDFILE, String(process.pid));
fs.writeFileSync(process.env.READY, 'ready');
setInterval(() => {}, 1000);
`);
    child = Bun.spawn(["node", fixture], {
      env: { ...process.env, HARPER_TEST_ROOT: join(repoRoot, "node_modules/harper/dist"), ROOTPATH: dataDir,
        REMOVED: join(home, "removed"), PIDFILE: join(dataDir, "hdb.pid"), READY: join(home, "ready") },
      stdout: "ignore", stderr: "pipe",
    });
    const deadline = Date.now() + 5000;
    while (!existsSync(join(home, "ready")) && Date.now() < deadline && child.exitCode === null) await Bun.sleep(10);
    if (!existsSync(join(home, "ready"))) throw new Error("Harper handler did not become ready");
    process.kill(child.pid, 0);
    writeFileSync(sidecar, JSON.stringify({ pid: child.pid, startTimeMs: Date.now(), port: 9, flairVersion: "test" }));
    return child.pid;
  }

  async function stop(pid: number, unloadFails = false, accelerated = false) {
    writeFileSync(join(shimBin, "launchctl"), unloadFails ? "#!/bin/sh\nexit 7\n" : `#!/bin/sh\nkill -TERM ${pid}\n`, { mode: 0o755 });
    const runner = join(home, "stop.ts");
    writeFileSync(runner, `
const { program } = await import(${JSON.stringify(join(repoRoot, "src/cli.ts"))});
Object.defineProperty(process, 'platform', { value: 'darwin' });
${accelerated ? `
const started = Date.now();
let elapsed = 0;
Date.now = () => started + elapsed;
const timeout = globalThis.setTimeout;
globalThis.setTimeout = ((fn, ms, ...args) => ms === 500
  ? timeout(() => { elapsed += ms; fn(...args); }, 1)
  : timeout(fn, ms, ...args));` : ""}
await program.parseAsync(['bun', 'flair', 'stop']);
`);
    const proc = Bun.spawn(["bun", runner], {
      cwd: repoRoot, timeout: 10_000,
      env: { ...process.env, HOME: home, PATH: `${shimBin}:${process.env.PATH ?? ""}` },
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ]);
    return { out: stdout + stderr, code };
  }

  test("delayed exit after unload removes the sidecar after the recorded process exits", async () => {
    const pid = await liveHarperHandler("delayed");
    const result = await stop(pid);
    expect(result.code).toBe(0);
    expect(result.out).toContain("Flair stopped (launchd service unloaded)");
    expect(readFileSync(join(home, "removed"), "utf8")).toBe("true");
    expect(existsSync(join(dataDir, "hdb.pid"))).toBe(false);
    expect(child?.exitCode).toBe(0);
    expect(existsSync(sidecar)).toBe(false);
  }, 20_000);

  test("unconfirmed exit reports a named failure and keeps the sidecar", async () => {
    const pid = await liveHarperHandler("stays");
    const result = await stop(pid, false, true);
    expect(result.code).toBe(1);
    expect(result.out).toContain(`flair stop: launchd stop failed for ${dataDir} (pid ${pid})`);
    expect(result.out).toContain(`Process ${pid} did not exit within 60000ms`);
    expect(result.out).toContain("Fix: flair doctor --fix");
    expect(result.out).not.toContain("Flair stopped");
    expect(readFileSync(join(home, "removed"), "utf8")).toBe("true");
    process.kill(pid, 0);
    expect(existsSync(sidecar)).toBe(true);
  }, 20_000);

  test("unload failure reports a named failure and keeps the sidecar", async () => {
    const pid = await liveHarperHandler("stays");
    const result = await stop(pid, true);
    expect(result.code).toBe(1);
    expect(result.out).toContain(`flair stop: launchd stop failed for ${dataDir} (pid ${pid})`);
    expect(result.out).toContain("Fix: flair doctor --fix");
    expect(result.out).not.toContain("Flair stopped");
    expect(existsSync(join(home, "removed"))).toBe(false);
    process.kill(pid, 0);
    expect(existsSync(sidecar)).toBe(true);
  }, 20_000);

  for (const recorded of [null, "invalid"]) {
    test(`unreadable recorded PID (${recorded ?? "missing"}) refuses before unloading`, async () => {
      const pid = await liveHarperHandler("stays");
      if (recorded === null) rmSync(join(dataDir, "hdb.pid"));
      else writeFileSync(join(dataDir, "hdb.pid"), recorded);
      const result = await stop(pid);
      expect(result.code).toBe(1);
      expect(result.out).toContain("(pid unknown)");
      expect(result.out).toContain("Fix: flair doctor --fix");
      expect(result.out).not.toContain("Flair stopped");
      expect(existsSync(join(home, "removed"))).toBe(false);
      expect(existsSync(sidecar)).toBe(true);
    }, 20_000);
  }
});
