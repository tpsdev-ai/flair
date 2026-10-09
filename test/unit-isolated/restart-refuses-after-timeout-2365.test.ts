import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { classifyHealthProbe } from "../../src/lib/daemon-liveness.js";

const started = Date.now();
mock.module("../../src/lib/process-start-time.js", () => ({
  readProcessStartTimeMs: () => started,
  readProcessStartSecondMs: () => started,
}));
const { launchdLabel, launchdPlistPath, probePidLiveness, program, restartFlair } = await import("../../src/cli.ts");
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

  function arrangeLaunchd(pid: number): void {
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
        replacementStarted = true;
        expect(probePidLiveness(pid)).toEqual({ kind: "gone" });
      },
    })).resolves.toBeUndefined();
    expect(replacementStarted).toBe(true);
  }, 20_000);

  test("launchd wait failure retains its pid and remedy after Harper removes the pidfile", async () => {
    const { pid, port } = await arrangeLiveInstance(true);
    arrangeLaunchd(pid);
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

  test.each([false, true])("launchd fallback after a failed wait checks the retained pid (exited: %s)", async (exited) => {
    const { pid, port } = await arrangeLiveInstance(true);
    arrangeLaunchd(pid);
    rmSync(join(dataDir, "flair-daemon.json"));
    let replacementStarted = false;
    const err = await restartFlair(port, dataDir, {
      waitForExit: async (waitedPid, timeoutMs) => {
        expect(waitedPid).toBe(pid);
        const deadline = Date.now() + 5000;
        while (!existsSync(join(home, "removed")) && Date.now() < deadline) await Bun.sleep(10);
        expect(readFileSync(join(home, "removed"), "utf8")).toBe("true");
        expect(existsSync(join(dataDir, "hdb.pid"))).toBe(false);
        expect(existsSync(join(dataDir, "flair-daemon.json"))).toBe(false);
        expect(probePidLiveness(pid)).toEqual({ kind: "alive" });
        if (exited) {
          decoy!.kill("SIGKILL");
          await decoy!.exited;
        }
        throw new Error(`Process ${waitedPid} did not exit within ${timeoutMs}ms`);
      },
      startReplacement: async () => {
        replacementStarted = true;
        expect(probePidLiveness(pid)).toEqual({ kind: "gone" });
      },
    }).then(() => null, (e: unknown) => e as Error);
    expect(fetchSpy).toHaveBeenCalled();
    expect(replacementStarted).toBe(exited);
    if (exited) {
      expect(err).toBeNull();
    } else {
      expect(err).toBeInstanceOf(Error);
      expect(err!.message).toContain(`pid ${pid}`);
      expect(err!.message).toContain("refusing to start a replacement");
      expect(err!.message).toContain("Stop it, then re-run 'flair restart'");
      expect(probePidLiveness(pid)).toEqual({ kind: "alive" });
    }
  }, 20_000);

  test.each(["healthy", "unreachable"])("launchd fallback rechecks the live pid after a second wait resolves (health: %s)", async (health) => {
    const { pid, port } = await arrangeLiveInstance();
    arrangeLaunchd(pid);
    const healthyBody = { ok: true, version: "test", searchReady: true, buildCommit: null };
    expect(classifyHealthProbe({ kind: "response", status: 200, body: healthyBody })).toEqual({ kind: "ok" });
    fetchSpy.mockImplementation((async () => {
      if (health === "unreachable") throw new Error("unreachable");
      return new Response(JSON.stringify(healthyBody));
    }) as unknown as typeof fetch);
    let waits = 0;
    let replacementStarted = false;
    const err = await restartFlair(port, dataDir, {
      waitForExit: async (waitedPid) => {
        expect(waitedPid).toBe(pid);
        if (++waits === 1) throw new Error("launchd wait failed");
      },
      startReplacement: async () => { replacementStarted = true; },
    }).then(() => null, (e: unknown) => e as Error);
    expect(waits).toBe(2);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain(`pid ${pid}`);
    expect(err!.message).toContain("refusing to start a replacement");
    expect(replacementStarted).toBe(false);
    expect(probePidLiveness(pid)).toEqual({ kind: "alive" });
  }, 20_000);

  test("snapshot restore emits a stop failure without a restart remedy", async () => {
    const { pid, port } = await arrangeLiveInstance(true);
    arrangeLaunchd(pid);
    const snapshot = join(home, "snapshot.tar.gz");
    writeFileSync(snapshot, "unopened");
    let elapsed = 0;
    const now = spyOn(Date, "now").mockImplementation(() => started + elapsed);
    const realSetTimeout = globalThis.setTimeout;
    const sleep = spyOn(globalThis, "setTimeout").mockImplementation(((fn: (...args: unknown[]) => void, ms: number, ...args: unknown[]) => {
      if (ms === 500) return realSetTimeout(() => { elapsed += ms; fn(...args); }, 10);
      return realSetTimeout(fn, ms, ...args);
    }) as typeof setTimeout);
    const error = spyOn(console, "error").mockImplementation(() => {});
    const exit = spyOn(process, "exit").mockImplementation(((code) => {
      throw new Error(`exit ${code}`);
    }) as typeof process.exit);
    try {
      await expect(program.parseAsync(["node", "flair", "snapshot", "restore", snapshot,
        "--data-dir", dataDir, "--port", String(port), "--yes"])).rejects.toThrow("exit 1");
      const emitted = error.mock.calls.map(call => call.join(" ")).join("\n");
      expect(emitted).toContain("failed to stop Flair: refusing to stop:");
      expect(emitted).toContain(`pid ${pid}`);
      expect(emitted).toContain("Could not confirm");
      expect(emitted).not.toContain("flair restart");
      expect(readFileSync(snapshot, "utf8")).toBe("unopened");
      expect(probePidLiveness(pid)).toEqual({ kind: "alive" });
    } finally {
      exit.mockRestore();
      error.mockRestore();
      sleep.mockRestore();
      now.mockRestore();
    }
  }, 20_000);
});
