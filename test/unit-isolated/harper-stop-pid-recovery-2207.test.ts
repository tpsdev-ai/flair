import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { atomicSignalWriterSource } from "../helpers/atomic-signal-source.ts";
import * as childProcess from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tempDir } from "../helpers/temp-dir.ts";
import { classifyDaemonState } from "../../src/lib/daemon-liveness.ts";

const started = Date.now();
mock.module("../../src/lib/process-start-time.js", () => ({
  readProcessStartTimeMs: () => started,
  readProcessStartSecondMs: () => started,
}));
mock.module("node:child_process", () => ({
  ...childProcess,
  spawn: () => { throw new Error("replacement spawn reached"); },
}));
const { gatherDaemonEvidence, program } = await import("../../src/cli.ts");
const savedHome = process.env.HOME;
afterEach(() => { process.env.HOME = savedHome; });

test("start attempts a replacement after Harper's SIGTERM handler removes the pid and the process exits", async () => {
  const home = tempDir("s");
  const dataDir = join(home, ".flair", "data");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  process.env.HOME = home;
  const ready = join(home, "ready");
  const removed = join(home, "removed");
  const pidfile = join(dataDir, "hdb.pid");
  const script = join(home, "harper-handler.cjs");
  const harperRoot = resolve(import.meta.dir, "../../node_modules/harper/dist");
  writeFileSync(script, `
const fs = require('node:fs');
${atomicSignalWriterSource}
const path = require('node:path');
const env = require(path.join(process.env.HARPER_TEST_ROOT, 'utility/environment/environmentManager.js'));
const run = require(path.join(process.env.HARPER_TEST_ROOT, 'bin/run.js'));
env.setProperty('ROOTPATH', process.env.ROOTPATH);
run.addExitListeners();
process.exit = () => publishSignal(process.env.REMOVED, String(!fs.existsSync(process.env.PIDFILE)));
fs.writeFileSync(process.env.PIDFILE, String(process.pid));
fs.writeFileSync(process.env.READY, 'ready');
setInterval(() => {}, 1000);
`);
  const child = Bun.spawn(["node", script], {
    env: { ...process.env, HARPER_TEST_ROOT: harperRoot, ROOTPATH: dataDir, READY: ready, REMOVED: removed, PIDFILE: pidfile },
    stdout: "ignore", stderr: "pipe",
  });
  let now: ReturnType<typeof spyOn> | undefined;
  let sleep: ReturnType<typeof spyOn> | undefined;
  let fetchSpy: ReturnType<typeof spyOn> | undefined;
  try {
    const readyDeadline = Date.now() + 5000;
    while (!existsSync(ready) && Date.now() < readyDeadline && child.exitCode === null) await Bun.sleep(10);
    if (!existsSync(ready)) {
      const detail = child.exitCode === null ? "Harper handler fixture did not become ready" : await new Response(child.stderr).text();
      throw new Error(detail);
    }
    const port = 19995;
    writeFileSync(join(dataDir, "flair-daemon.json"), JSON.stringify({ pid: child.pid, port, startTimeMs: started, flairVersion: "test" }));
    let portRefused = false;
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
      if (portRefused) throw Object.assign(new Error("refused"), { cause: { code: "ECONNREFUSED" } });
      return new Response(JSON.stringify({ ok: true, version: "test", searchReady: true }));
    }) as unknown as typeof fetch);
    let elapsed = 0;
    const realSetTimeout = globalThis.setTimeout;
    now = spyOn(Date, "now").mockImplementation(() => started + elapsed);
    sleep = spyOn(globalThis, "setTimeout").mockImplementation(((fn: (...args: unknown[]) => void, ms: number, ...args: unknown[]) => {
      if (ms === 500) return realSetTimeout(() => { elapsed += ms; fn(...args); }, 10);
      return realSetTimeout(fn, ms, ...args);
    }) as typeof setTimeout);
    await expect(program.parseAsync(["node", "flair", "stop", "--port", String(port)]))
      .rejects.toThrow(`Process ${child.pid} did not exit within 60000ms`);
    expect(readFileSync(removed, "utf8")).toBe("true");
    expect(existsSync(pidfile)).toBe(false);
    expect(child.exitCode).toBeNull();
    portRefused = true;
    expect(classifyDaemonState(await gatherDaemonEvidence(port, dataDir), { port, dataDir }).state).toBe("DISAGREEMENT");
    child.kill("SIGKILL");
    await child.exited;
    const evidence = await gatherDaemonEvidence(port, dataDir);
    expect(evidence.pidLiveness).toEqual({ kind: "gone" });
    expect(evidence.health).toEqual({ kind: "refused" });
    expect(evidence.pidfile).toEqual({ kind: "absent" });
    expect(classifyDaemonState(evidence, { port, dataDir }).state).toBe("NOT_RUNNING");
    await expect(program.parseAsync(["node", "flair", "start", "--port", String(port)]))
      .rejects.toThrow("replacement spawn reached");
  } finally {
    now?.mockRestore();
    sleep?.mockRestore();
    fetchSpy?.mockRestore();
    child.kill("SIGKILL");
    await child.exited;
  }
}, 20_000);
