// flair#1450 — an orphaned test Harper must EXIT, not EPIPE-loop.
//
// The 2026-08-29 tps-anvil incident: the harness parent died, `node harper.js
// dev` was reparented to systemd --user, each failed write logged an error,
// logging that error also failed, 17.8 GB in two hours. #1440 waits for the
// RocksDB lock on the *next* start; it does not stop a detached child from
// surviving its parent. The exit hook in harper-lifecycle.ts cannot cover
// SIGKILL of the harness, and this file must not add process-wide signal
// handlers (federation-watch.test.ts SIGTERMs the runner as a fixture).
//
// Powered check: kill the parent, assert the child is GONE within a bounded
// window — not that the disk grew more slowly. Today (no preload) the child
// survives indefinitely, so that assertion fails on current spawn-without-
// preload, which is the known-answer.
//
// Positive control: parent alive and stdout open → child must NOT exit.
// A child that dies on a pipe hiccup (backpressure, not EPIPE) is the
// wrong trade.
//
// These tests spawn `node` (Harper's runtime), not bun, and kill by explicit
// PID only. Two processes can share the name harper.js; never pattern-sweep.
import { describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { applyOrphanExitPreload, ORPHAN_EXIT_PRELOAD } from "../helpers/harper-lifecycle.js";

const NODE_BIN = process.env.NODE_BIN ?? "node";
const SRC = readFileSync(join(import.meta.dir, "..", "helpers", "harper-lifecycle.ts"), "utf8");
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const PRELOAD_SRC = readFileSync(ORPHAN_EXIT_PRELOAD, "utf8");

const CHILD_SCRIPT = `
process.stdout.write(JSON.stringify({ pid: process.pid, ppid: process.ppid }) + "\\n");
setInterval(() => { console.error("heartbeat"); }, 50);
`;

const PARENT_SCRIPT = `
const { spawn } = require("node:child_process");
const env = { ...process.env };
const preload = process.env.FLAIR_ORPHAN_PRELOAD;
if (preload) {
  env.NODE_OPTIONS = [env.NODE_OPTIONS, "--require=" + preload].filter(Boolean).join(" ");
} else if (env.NODE_OPTIONS) {
  env.NODE_OPTIONS = env.NODE_OPTIONS.split(/\\s+/).filter((t) => !t.includes("harper-orphan-exit")).join(" ");
}
const child = spawn(process.execPath, ["-e", process.env.FLAIR_ORPHAN_CHILD], {
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
let buf = "";
child.stdout.on("data", (d) => {
  buf += d;
  const nl = buf.indexOf("\\n");
  if (nl !== -1) process.stdout.write(buf.slice(0, nl + 1));
});
child.stderr.on("data", () => {});
setInterval(() => {}, 1 << 30);
`;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killPid(pid: number | undefined | null): void {
  if (!pid) return;
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
}

function readChildPid(parent: ChildProcess, timeoutMs = 5_000): Promise<number> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error(`parent did not report child pid: ${buf}`)), timeoutMs);
    const onData = (d: Buffer) => {
      buf += d.toString();
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      clearTimeout(timer);
      parent.stdout?.off("data", onData);
      try {
        const parsed = JSON.parse(buf.slice(0, nl));
        if (!parsed.pid) throw new Error(`no pid in ${buf.slice(0, nl)}`);
        resolve(Number(parsed.pid));
      } catch (err) {
        reject(err);
      }
    };
    parent.stdout?.on("data", onData);
    parent.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`parent exited before reporting pid (code=${code} signal=${signal}) ${buf}`));
    });
  });
}

async function waitUntil(pred: () => boolean, timeoutMs: number, intervalMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return pred();
}

function spawnParent(opts: { preload: boolean }): ChildProcess {
  return spawn(NODE_BIN, ["-e", PARENT_SCRIPT], {
    env: {
      ...process.env,
      FLAIR_ORPHAN_CHILD: CHILD_SCRIPT,
      ...(opts.preload ? { FLAIR_ORPHAN_PRELOAD: ORPHAN_EXIT_PRELOAD } : { FLAIR_ORPHAN_PRELOAD: "" }),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("flair#1450 — orphaned child must exit, not loop", () => {
  test("known-answer: without the preload, killing the parent leaves the child alive", async () => {
    const parent = spawnParent({ preload: false });
    let childPid = 0;
    try {
      childPid = await readChildPid(parent);
      expect(isAlive(childPid)).toBe(true);
      killPid(parent.pid);
      const survived = await waitUntil(() => !isAlive(childPid), 1_500);
      // The defect: the child is still running. This is the assertion that
      // fails on current code (no preload) and makes the powered check a
      // known-answer — if this ever flips, the stand-in no longer models Harper.
      expect(survived).toBe(false);
      expect(isAlive(childPid)).toBe(true);
    } finally {
      killPid(childPid);
      killPid(parent.pid);
    }
  }, 15_000);

  test("powered check: with the preload, killing the parent makes the child gone", async () => {
    const parent = spawnParent({ preload: true });
    let childPid = 0;
    try {
      childPid = await readChildPid(parent);
      expect(isAlive(childPid)).toBe(true);
      killPid(parent.pid);
      const gone = await waitUntil(() => !isAlive(childPid), 3_000);
      expect(gone).toBe(true);
      expect(isAlive(childPid)).toBe(false);
    } finally {
      killPid(childPid);
      killPid(parent.pid);
    }
  }, 15_000);

  test("positive control: parent alive and stdout open → child stays", async () => {
    const parent = spawnParent({ preload: true });
    let childPid = 0;
    try {
      childPid = await readChildPid(parent);
      expect(isAlive(childPid)).toBe(true);
      await new Promise((r) => setTimeout(r, 1_500));
      expect(isAlive(parent.pid!)).toBe(true);
      expect(isAlive(childPid)).toBe(true);
    } finally {
      killPid(childPid);
      killPid(parent.pid);
    }
  }, 15_000);

  test("positive control: backpressure (pipe hiccup) is not EPIPE — child stays", async () => {
    // Fill the pipe without closing it. write() returning false / blocking is
    // not EPIPE; exiting here would trade an orphan for a process that dies
    // whenever a reader is slow.
    const child = spawn(NODE_BIN, ["-e", `
      require(${JSON.stringify(ORPHAN_EXIT_PRELOAD)});
      process.stdout.write(JSON.stringify({ pid: process.pid }) + "\\n");
      const chunk = Buffer.alloc(16 * 1024, 0x61);
      const pump = () => { while (process.stdout.write(chunk)) { /* fill */ } };
      process.stdout.on("drain", pump);
      pump();
      setInterval(() => {}, 1 << 30);
    `], { stdio: ["ignore", "pipe", "ignore"] });
    try {
      const pid = await readChildPid(child);
      child.stdout?.pause();
      await new Promise((r) => setTimeout(r, 1_000));
      expect(isAlive(pid)).toBe(true);
    } finally {
      killPid(child.pid);
    }
  }, 15_000);
});

describe("flair#1450 — wiring, not a process-name sweep", () => {
  test("the preload file exists next to the lifecycle helper", () => {
    expect(existsSync(ORPHAN_EXIT_PRELOAD)).toBe(true);
    expect(ORPHAN_EXIT_PRELOAD.endsWith("harper-orphan-exit.cjs")).toBe(true);
  });

  test("startHarper injects the preload into NODE_OPTIONS", () => {
    expect(CODE).toMatch(/applyOrphanExitPreload\(baseEnv\)/);
    expect(CODE).toMatch(/ORPHAN_EXIT_PRELOAD/);
    expect(CODE).toMatch(/harper-orphan-exit\.cjs/);
  });

  test("applyOrphanExitPreload appends and does not clobber existing NODE_OPTIONS", () => {
    const env = { NODE_OPTIONS: "--enable-source-maps" };
    applyOrphanExitPreload(env);
    expect(env.NODE_OPTIONS).toContain("--enable-source-maps");
    expect(env.NODE_OPTIONS).toContain(`--require=${ORPHAN_EXIT_PRELOAD}`);
    applyOrphanExitPreload(env);
    expect(env.NODE_OPTIONS.match(/harper-orphan-exit\.cjs/g)?.length).toBe(1);
  });

  test("the preload keys on EPIPE and ppid, never on process name", () => {
    expect(PRELOAD_SRC).toMatch(/EPIPE/);
    expect(PRELOAD_SRC).toMatch(/process\.ppid/);
    expect(PRELOAD_SRC).not.toMatch(/pkill|killall|pgrep/);
    expect(PRELOAD_SRC).not.toMatch(/harper\.js/);
  });

  test("the lifecycle helper still registers no process-wide signal handlers", () => {
    expect(CODE).not.toMatch(/process\.on\(\s*["']SIG/);
  });
});
