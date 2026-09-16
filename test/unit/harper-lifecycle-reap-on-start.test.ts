// flair#1372 — reap-on-start must kill a stamped orphan Harper, then remove
// its tree. Ask 2 (runner signal handlers) is withdrawn; the no-SIG pins stay.
//
// T1–T4 are the spec cases (Flint 2026-09-15 + Kern A1–A3). They plant a
// leftover `flair-test-*` tree and call sweepStaleHarperTrees — the same
// chokepoint startHarper already runs. Kill is by explicit stamped pid only.
import { describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepStaleHarperTrees } from "../helpers/harper-lifecycle.js";
import {
  SCRATCH_OWNER_FILE,
  writeScratchOwnerStamp,
} from "../../src/lib/scratch-owner.js";
import { isStartTimeMatch } from "../../src/lib/daemon-liveness.js";
import { readProcessStartTimeMs } from "../../src/lib/process-start-time.js";

const NODE_BIN = process.env.NODE_BIN ?? "node";
const SRC = readFileSync(join(import.meta.dir, "..", "helpers", "harper-lifecycle.ts"), "utf8");
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const STAMP_SRC = readFileSync(join(import.meta.dir, "..", "..", "src", "lib", "scratch-owner.ts"), "utf8");
const STAMP_CODE = STAMP_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

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

function spawnStandIn(): ChildProcess {
  return spawn(NODE_BIN, ["-e", `
    process.stdout.write(JSON.stringify({ pid: process.pid }) + "\\n");
    setInterval(() => {}, 1 << 30);
  `], { stdio: ["ignore", "pipe", "ignore"] });
}

function readChildPid(child: ChildProcess, timeoutMs = 5_000): Promise<number> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error(`stand-in did not report pid: ${buf}`)), timeoutMs);
    const onData = (d: Buffer) => {
      buf += d.toString();
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      try {
        const parsed = JSON.parse(buf.slice(0, nl));
        if (!parsed.pid) throw new Error(`no pid in ${buf.slice(0, nl)}`);
        resolve(Number(parsed.pid));
      } catch (err) {
        reject(err);
      }
    };
    child.stdout?.on("data", onData);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`stand-in exited before reporting pid (code=${code} signal=${signal}) ${buf}`));
    });
  });
}

function plantTree(): string {
  return mkdtempSync(join(tmpdir(), "flair-test-reap-"));
}

function writeStamp(dir: string, stamp: Record<string, number>): void {
  writeFileSync(join(dir, SCRATCH_OWNER_FILE), JSON.stringify(stamp) + "\n");
}

function writeHdbPid(dir: string, pid: number): void {
  writeFileSync(join(dir, "hdb.pid"), `${pid}\n`);
}

describe("flair#1372 — stamp format (owner + harper start times)", () => {
  test("writeScratchOwnerStamp records ownerPid and ownerStartedAt, not a bare pid", () => {
    const dir = plantTree();
    try {
      writeScratchOwnerStamp(dir);
      const raw = readFileSync(join(dir, SCRATCH_OWNER_FILE), "utf8");
      const stamp = JSON.parse(raw) as { ownerPid: number; ownerStartedAt: number };
      expect(stamp.ownerPid).toBe(process.pid);
      expect(typeof stamp.ownerStartedAt).toBe("number");
      const live = readProcessStartTimeMs(process.pid);
      expect(live).not.toBeNull();
      expect(isStartTimeMatch(live!, stamp.ownerStartedAt)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the stamp schema names harperPid and harperStartedAt (Kern A1)", () => {
    expect(STAMP_CODE).toMatch(/harperPid/);
    expect(STAMP_CODE).toMatch(/harperStartedAt/);
    expect(STAMP_CODE).toMatch(/ownerStartedAt/);
    expect(STAMP_CODE).toMatch(/isStartTimeMatch/);
    expect(STAMP_CODE).toMatch(/readProcessStartTimeMs/);
  });
});

describe("flair#1372 T1 — dead owner + identity-matched live harper is killed, then the tree is removed", () => {
  test("sweep kills the stamped harperPid and removes installDir", async () => {
    const child = spawnStandIn();
    let childPid = 0;
    const dir = plantTree();
    try {
      childPid = await readChildPid(child);
      const startedAt = readProcessStartTimeMs(childPid);
      expect(startedAt).not.toBeNull();
      writeStamp(dir, {
        ownerPid: 999999999,
        ownerStartedAt: 1,
        harperPid: childPid,
        harperStartedAt: startedAt!,
      });
      writeHdbPid(dir, childPid);
      expect(isAlive(childPid)).toBe(true);

      const died = new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
      });
      const removed = sweepStaleHarperTrees({ olderThanMs: 0 });
      expect(removed).toBeGreaterThanOrEqual(1);
      await Promise.race([
        died,
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error(`stand-in ${childPid} did not exit after sweep`)), 5_000)),
      ]);
      expect(isAlive(childPid)).toBe(false);
      expect(existsSync(dir)).toBe(false);
    } finally {
      killPid(childPid);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});

describe("flair#1372 T2 — sibling with a live owner is not killed", () => {
  test("a tree whose owner pid+start-time still match survives sweep", async () => {
    const child = spawnStandIn();
    let childPid = 0;
    const dir = plantTree();
    try {
      childPid = await readChildPid(child);
      const ownerStartedAt = readProcessStartTimeMs(process.pid);
      const harperStartedAt = readProcessStartTimeMs(childPid);
      expect(ownerStartedAt).not.toBeNull();
      expect(harperStartedAt).not.toBeNull();
      writeStamp(dir, {
        ownerPid: process.pid,
        ownerStartedAt: ownerStartedAt!,
        harperPid: childPid,
        harperStartedAt: harperStartedAt!,
      });
      writeHdbPid(dir, childPid);

      sweepStaleHarperTrees({ olderThanMs: 0 });
      expect(existsSync(dir)).toBe(true);
      expect(isAlive(childPid)).toBe(true);
    } finally {
      killPid(childPid);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});

describe("flair#1372 T3 — recycled owner pid fails closed; mismatched harper is not killed", () => {
  test("owner pid alive but started-at mismatches → tree is swept", () => {
    const dir = plantTree();
    try {
      // Legacy pid-only stamp of a still-live pid (today's recycled-pid shape)
      // plus a JSON stamp whose started-at cannot match. Either form is "dead".
      writeStamp(dir, {
        ownerPid: process.pid,
        ownerStartedAt: 1,
      });
      const removed = sweepStaleHarperTrees({ olderThanMs: 0 });
      expect(removed).toBeGreaterThanOrEqual(1);
      expect(existsSync(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("legacy pid-only stamp of a live pid is not treated as a live owner", () => {
    const dir = plantTree();
    try {
      writeFileSync(join(dir, SCRATCH_OWNER_FILE), `${process.pid}\n`);
      const removed = sweepStaleHarperTrees({ olderThanMs: 0 });
      expect(removed).toBeGreaterThanOrEqual(1);
      expect(existsSync(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("A1 twin: stamped harperPid alive but start-time mismatched → not killed; tree swept", async () => {
    const child = spawnStandIn();
    let childPid = 0;
    const dir = plantTree();
    try {
      childPid = await readChildPid(child);
      writeStamp(dir, {
        ownerPid: 999999999,
        ownerStartedAt: 1,
        harperPid: childPid,
        harperStartedAt: 1,
      });
      writeHdbPid(dir, childPid);
      expect(isAlive(childPid)).toBe(true);

      const removed = sweepStaleHarperTrees({ olderThanMs: 0 });
      expect(removed).toBeGreaterThanOrEqual(1);
      expect(isAlive(childPid)).toBe(true);
      expect(existsSync(dir)).toBe(false);
    } finally {
      killPid(childPid);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});

describe("flair#1372 T4 — stampless tree with a foreign live hdb.pid is untouched", () => {
  test("no stamp + live hdb.pid (sibling-harness shape) → no kill, tree stays", async () => {
    const child = spawnStandIn();
    let childPid = 0;
    const dir = plantTree();
    try {
      childPid = await readChildPid(child);
      writeHdbPid(dir, childPid);
      expect(existsSync(join(dir, SCRATCH_OWNER_FILE))).toBe(false);

      sweepStaleHarperTrees({ olderThanMs: 0 });
      expect(existsSync(dir)).toBe(true);
      expect(isAlive(childPid)).toBe(true);
    } finally {
      killPid(childPid);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});

describe("flair#1372 A3 — hdb.pid vs stamped harperPid disagreement skips both", () => {
  test("disagreeing pids → neither killed, tree left (and warned)", async () => {
    const child = spawnStandIn();
    let childPid = 0;
    const dir = plantTree();
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warns.push(args.map(String).join(" "));
    };
    try {
      childPid = await readChildPid(child);
      writeStamp(dir, {
        ownerPid: 999999999,
        ownerStartedAt: 1,
        harperPid: childPid + 1,
        harperStartedAt: 1,
      });
      writeHdbPid(dir, childPid);

      sweepStaleHarperTrees({ olderThanMs: 0 });
      expect(existsSync(dir)).toBe(true);
      expect(isAlive(childPid)).toBe(true);
      expect(warns.some((w) => w.includes("hdb.pid") && w.includes("harperPid"))).toBe(true);
    } finally {
      console.warn = origWarn;
      killPid(childPid);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});

describe("flair#1372 — wiring pins (A2, reuse daemon-liveness, no new kill surface)", () => {
  test("A2: startHarper writes the owner stamp before harper install/spawn, including caller-supplied installDir", () => {
    expect(CODE).toMatch(/writeScratchOwnerStamp\(installDir/);
    expect(CODE).not.toMatch(/if \(ownsInstallDir\) writeScratchOwnerStamp/);
    const stampAt = CODE.indexOf("writeScratchOwnerStamp(installDir)");
    const installAt = CODE.indexOf('spawn(NODE_BIN, [HARPER_BIN, "install"]');
    expect(stampAt).toBeGreaterThan(-1);
    expect(installAt).toBeGreaterThan(-1);
    expect(stampAt).toBeLessThan(installAt);
  });

  test("sweep kill is gated on isStartTimeMatch — never a pid-only kill of hdb.pid", () => {
    expect(CODE).toMatch(/isStartTimeMatch/);
    const killer = CODE.slice(
      CODE.indexOf("function killVerifiedOrphanPid"),
      CODE.indexOf("export function sweepStaleHarperTrees"),
    );
    expect(killer).toMatch(/isStartTimeMatch/);
    expect(killer).toMatch(/SIGTERM/);
    expect(killer).toMatch(/SIGKILL/);
    expect(killer.indexOf("isStartTimeMatch")).toBeLessThan(killer.indexOf("SIGTERM"));
    expect(killer.indexOf("SIGTERM")).toBeLessThan(killer.indexOf("SIGKILL"));
    expect(killer).not.toMatch(/pkill|killall/);
    const sweep = CODE.slice(CODE.indexOf("export function sweepStaleHarperTrees"), CODE.indexOf("const STARTUP_TIMEOUT_MS"));
    expect(sweep.indexOf("killVerifiedOrphanPid")).toBeLessThan(sweep.indexOf("rmSync"));
  });

  test("existing no-signal and no-pattern-kill pins still hold", () => {
    expect(CODE).not.toMatch(/process\.on\(\s*["']SIG/);
    expect(CODE).not.toMatch(/pkill|killall/);
    expect(CODE).toMatch(/process\.on\("exit", reapLiveInstances\)/);
  });

  test("startHarper still sweeps before mkdtemp", () => {
    const sweepAt = CODE.indexOf("sweepStaleHarperTrees()");
    const mkdtempAt = CODE.indexOf('mkdtemp(join(tmpdir(), "flair-test-")');
    expect(sweepAt).toBeGreaterThan(-1);
    expect(mkdtempAt).toBeGreaterThan(-1);
    expect(sweepAt).toBeLessThan(mkdtempAt);
  });
});
