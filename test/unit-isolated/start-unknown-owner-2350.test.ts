import { afterEach, expect, mock, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tempDir } from "../helpers/temp-dir.ts";
import { classifyDaemonState } from "../../src/lib/daemon-liveness.ts";
import { probePortListening } from "../../src/lib/stop-start-recovery.ts";

let replacements = 0;
mock.module("node:child_process", () => ({
  ...childProcess,
  spawn: () => { replacements++; throw new Error("replacement spawn reached"); },
}));
// This fixture never binds an operations socket.
mock.module("../../src/lib/socket-path-limit.js", () => ({ opsSocketPathRefusal: () => null }));
const { gatherDaemonEvidence, program } = await import("../../src/cli.ts");
const savedHome = process.env.HOME;
afterEach(() => { process.env.HOME = savedHome; });

test("start refuses a surviving Harper handler and reaches replacement spawn after its exit on UNKNOWN", async () => {
  const home = tempDir("s");
  const dataDir = join(home, ".flair", "data");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  process.env.HOME = home;
  const ready = join(home, "ready");
  const removed = join(home, "removed");
  const pidfile = join(dataDir, "hdb.pid");
  const sidecar = join(dataDir, "flair-daemon.json");
  const script = join(home, "harper-handler.cjs");
  writeFileSync(script, `
const fs = require('node:fs');
const path = require('node:path');
const env = require(path.join(process.env.HARPER_TEST_ROOT, 'utility/environment/environmentManager.js'));
const run = require(path.join(process.env.HARPER_TEST_ROOT, 'bin/run.js'));
env.setProperty('ROOTPATH', process.env.ROOTPATH);
run.addExitListeners();
process.exit = () => fs.writeFileSync(process.env.REMOVED, 'removed');
fs.writeFileSync(process.env.PIDFILE, String(process.pid));
fs.writeFileSync(process.env.READY, 'ready');
setInterval(() => {}, 1000);
`);
  const child = Bun.spawn(["node", script], {
    env: { ...process.env, HARPER_TEST_ROOT: resolve(import.meta.dir, "../../node_modules/harper/dist"),
      ROOTPATH: dataDir, READY: ready, REMOVED: removed, PIDFILE: pidfile },
    stdout: "ignore", stderr: "pipe",
  });
  const fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(new Error("health timeout"));
  const exitSpy = spyOn(process, "exit").mockImplementation(() => { throw new Error("start refused"); });
  replacements = 0;
  try {
    const deadline = Date.now() + 5000;
    while (!existsSync(ready) && Date.now() < deadline && child.exitCode === null) await Bun.sleep(10);
    expect(existsSync(ready)).toBe(true);
    const port = 59995;
    expect(await probePortListening(port)).toBe("free");
    writeFileSync(sidecar, JSON.stringify({ pid: child.pid, port, startTimeMs: Date.now(), flairVersion: "test" }));
    child.kill("SIGTERM");
    while (!existsSync(removed) && Date.now() < deadline) await Bun.sleep(10);
    expect(readFileSync(removed, "utf8")).toBe("removed");
    expect(existsSync(pidfile)).toBe(false);
    expect(child.exitCode).toBeNull();
    await expect(program.parseAsync(["node", "flair", "start", "--port", String(port)]))
      .rejects.toThrow("start refused");
    expect(replacements).toBe(0);
    child.kill("SIGKILL");
    await child.exited;
    expect(classifyDaemonState(await gatherDaemonEvidence(port, dataDir), { port, dataDir }).state).toBe("UNKNOWN");
    chmodSync(dataDir, 0o777);
    await expect(program.parseAsync(["node", "flair", "start", "--port", String(port)]))
      .rejects.toThrow("start refused");
    expect(replacements).toBe(0);
    chmodSync(dataDir, 0o700);
    writeFileSync(pidfile, "not a pid");
    await expect(program.parseAsync(["node", "flair", "start", "--port", String(port)]))
      .rejects.toThrow("start refused");
    expect(replacements).toBe(0);
    rmSync(pidfile);
    const ownerRecord = readFileSync(sidecar, "utf8");
    rmSync(sidecar);
    await expect(program.parseAsync(["node", "flair", "start", "--port", String(port)]))
      .rejects.toThrow("start refused");
    expect(replacements).toBe(0);
    writeFileSync(sidecar, ownerRecord);
    await expect(program.parseAsync(["node", "flair", "start", "--port", String(port)]))
      .rejects.toThrow("replacement spawn reached");
    expect(replacements).toBe(1);

    let reads = 0;
    fetchSpy.mockImplementation((async () => {
      if (++reads === 2) writeFileSync(pidfile, String(process.pid));
      throw new Error("health timeout");
    }) as unknown as typeof fetch);
    await expect(program.parseAsync(["node", "flair", "start", "--port", String(port)]))
      .rejects.toThrow("start refused");
    expect(replacements).toBe(1);
  } finally {
    fetchSpy.mockRestore();
    exitSpy.mockRestore();
    child.kill("SIGKILL");
    await child.exited;
  }
}, 20_000);
