/** The direct stop helper preserves best-effort timeout behavior for snapshot and upgrade stop callers; restart rejects its failed exit-wait outcome. */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const started = Date.now();
mock.module("../../src/lib/process-start-time.js", () => ({
  readProcessStartTimeMs: () => started,
  readProcessStartSecondMs: () => started,
}));
const { launchdLabel, launchdPlistPath, probePidLiveness, restartFlair } = await import("../../src/cli.ts");
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
const savedHome = process.env.HOME;
const savedPath = process.env.PATH;

describe("flair#2365 — restart and the stop leg's exit wait", () => {
  let home: string;
  let dataDir: string;
  let decoy: ReturnType<typeof Bun.spawn> | null = null;
  let fetchSpy: ReturnType<typeof spyOn>;
  let launchctlSpy: ReturnType<typeof spyOn> | undefined;
  let unloadSpy: ReturnType<typeof spyOn> | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "flair2365-"));
    dataDir = join(home, ".flair", "data");
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    process.env.HOME = home;
    Object.defineProperty(process, "platform", { value: "darwin" });
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
      throw Object.assign(new Error("refused"), { cause: { code: "ECONNREFUSED" } });
    }) as unknown as typeof fetch);
  });

  afterEach(async () => {
    if (decoy) {
      decoy.kill("SIGKILL");
      await decoy.exited;
      decoy = null;
    }
    fetchSpy.mockRestore();
    launchctlSpy?.mockRestore();
    launchctlSpy = undefined;
    unloadSpy?.mockRestore();
    unloadSpy = undefined;
    process.env.HOME = savedHome;
    process.env.PATH = savedPath;
    Object.defineProperty(process, "platform", platformDescriptor);
    rmSync(home, { recursive: true, force: true });
  });

  async function arrangeLiveInstance(harperHandler = false): Promise<{ pid: number; port: number }> {
    const port = 19995;
    const script = join(home, "handler.cjs");
    const pidfile = join(dataDir, "hdb.pid");
    writeFileSync(script, harperHandler ? String.raw`
const fs = require('node:fs');
const path = require('node:path');
const env = require(path.join(process.env.HARPER_TEST_ROOT, 'utility/environment/environmentManager.js'));
const run = require(path.join(process.env.HARPER_TEST_ROOT, 'bin/run.js'));
env.setProperty('ROOTPATH', process.env.ROOTPATH);
run.addExitListeners();
process.exit = () => fs.writeFileSync(process.env.REMOVED, String(!fs.existsSync(process.env.PIDFILE)));
process.stdout.write('ready\n');
setInterval(() => {}, 1000);
` : String.raw`process.on('SIGTERM', () => {}); process.stdout.write('ready\n'); setInterval(() => {}, 1000);`);
    decoy = Bun.spawn(["node", script], {
      env: { ...process.env, HARPER_TEST_ROOT: resolve(import.meta.dir, "../../node_modules/harper/dist"),
        ROOTPATH: dataDir, REMOVED: join(home, "removed"), PIDFILE: pidfile },
      stdout: "pipe", stderr: "pipe", timeout: 15_000,
    });
    const reader = (decoy.stdout as ReadableStream<Uint8Array>).getReader();
    const ready = await reader.read();
    reader.releaseLock();
    expect(new TextDecoder().decode(ready.value)).toBe("ready\n");
    const pid = decoy.pid;
    expect(probePidLiveness(pid)).toEqual({ kind: "alive" });
    writeFileSync(pidfile, `${pid}\n`);
    writeFileSync(join(dataDir, "flair-daemon.json"), JSON.stringify({
      pid, startTimeMs: started, port, flairVersion: "0.0.0",
    }));
    return { pid, port };
  }

  test("the refusal names the waited-on process and the remedy, and starts no replacement", async () => {
    const { pid, port } = await arrangeLiveInstance();
    let replacementStarted = false;
    const err = await restartFlair(port, dataDir, {
      waitForExit: async (waitedPid, timeoutMs) => {
        expect(waitedPid).toBe(pid);
        throw new Error(`Process ${waitedPid} did not exit within ${timeoutMs}ms`);
      },
      startReplacement: async () => { replacementStarted = true; },
    }).then(() => null, (e: unknown) => e as Error);

    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain(`pid ${pid}`);
    expect(err!.message).toContain("Could not confirm");
    expect(err!.message).toContain("exited within 60000ms");
    expect(err!.message).toContain("refusing to start a replacement");
    expect(err!.message).toContain("Stop it, then re-run 'flair restart'");
    expect(replacementStarted).toBe(false);
    expect(probePidLiveness(pid)).toEqual({ kind: "alive" });
    expect(decoy!.exitCode).toBeNull();
  }, 20_000);

  test("an exit wait that sees the old process gone still starts the replacement", async () => {
    const { pid, port } = await arrangeLiveInstance();
    let replacementStarted = false;
    await expect(restartFlair(port, dataDir, {
      waitForExit: async (waitedPid) => {
        expect(waitedPid).toBe(pid);
        decoy!.kill("SIGKILL");
        await decoy!.exited;
        expect(probePidLiveness(pid)).toEqual({ kind: "gone" });
      },
      startReplacement: async () => {
        expect(probePidLiveness(pid)).toEqual({ kind: "gone" });
        replacementStarted = true;
      },
    })).resolves.toBeUndefined();
    expect(replacementStarted).toBe(true);
  }, 20_000);

  test("launchd wait failure retains its pid and remedy after Harper removes the pidfile", async () => {
    const { pid, port } = await arrangeLiveInstance(true);
    const agentsDir = join(home, "Library", "LaunchAgents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(launchdPlistPath(launchdLabel(dataDir), agentsDir), "<plist/>");
    const bin = join(home, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "launchctl"), `#!/bin/sh
if [ "$1" = "list" ]; then
  echo '"PID" = ${pid};'
else
  kill -TERM ${pid}
fi
`, { mode: 0o755 });
    process.env.PATH = `${bin}:${savedPath ?? ""}`;
    const realExecSync = childProcess.execSync;
    unloadSpy = spyOn(childProcess, "execSync").mockImplementation(((command, opts) =>
      realExecSync(command, { ...opts, env: { ...process.env } })
    ) as typeof childProcess.execSync);
    const realSpawnSync = childProcess.spawnSync;
    launchctlSpy = spyOn(childProcess, "spawnSync").mockImplementation(((cmd, args, opts) =>
      realSpawnSync(cmd === "launchctl" ? join(bin, "launchctl") : cmd, args, opts)
    ) as typeof childProcess.spawnSync);
    let replacementStarted = false;
    let waited = false;
    const err = await restartFlair(port, dataDir, {
      waitForExit: async (waitedPid, timeoutMs) => {
        expect(waitedPid).toBe(pid);
        waited = true;
        const deadline = Date.now() + 5000;
        while (!existsSync(join(home, "removed")) && Date.now() < deadline) await Bun.sleep(10);
        expect(readFileSync(join(home, "removed"), "utf8")).toBe("true");
        expect(existsSync(join(dataDir, "hdb.pid"))).toBe(false);
        expect(JSON.parse(readFileSync(join(dataDir, "flair-daemon.json"), "utf8")).pid).toBe(pid);
        expect(probePidLiveness(pid)).toEqual({ kind: "alive" });
        throw new Error(`Process ${waitedPid} did not exit within ${timeoutMs}ms`);
      },
      startReplacement: async () => { replacementStarted = true; },
    }).then(() => null, (e: unknown) => e as Error);
    expect(waited).toBe(true);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain("refusing to stop:");
    expect(err!.message).toContain(`pid ${pid}`);
    expect(err!.message).toContain("Stop it, then re-run 'flair restart'");
    expect(err!.message).toContain("Could not confirm");
    expect(err!.message).toContain("refusing to start a replacement");
    expect(probePidLiveness(pid)).toEqual({ kind: "alive" });
    expect(decoy!.exitCode).toBeNull();
    expect(replacementStarted).toBe(false);
  }, 20_000);
});
