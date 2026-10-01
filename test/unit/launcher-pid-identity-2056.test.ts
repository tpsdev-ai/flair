// launcher-pid-identity-2056.test.ts — flair#2056.
//
// The launcher and resolveInstanceServingPid must identify the PROCESS behind
// hdb.pid, not just the pid: a sidecar (flair-daemon.json: same pid, start time
// within ±2 s) AND a node/harper command line. Otherwise the pid may have been
// recycled, and a stale hdb.pid must not block a launchd takeover.
//
// Hermetic: a stub node/harper that only prints a marker, and background
// processes this file starts and then kills by the pid it recorded. Every spawn
// is bounded (spawnSync timeout; the per-case timeout below).
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { readProcessStartTimeMs } from "../../src/lib/process-start-time.js";
import { isNodeHarperCommandLine } from "../../src/lib/daemon-liveness.js";
import { resolveInstanceServingPid } from "../../src/cli.ts";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const LAUNCHER = join(REPO_ROOT, "templates", "launchd", "start-flair-with-admin-pass.sh");
const MARKER = "STUB-HARPER-RAN";

const dirs: string[] = [];
const pids: number[] = [];

function mkRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "fl2056-"));
  dirs.push(root);
  return root;
}

function childEnv(root: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (/^(FLAIR_|HARPER_|HDB_|TPS_)/.test(k)) continue;
    env[k] = v;
  }
  env.ROOTPATH = root;
  return env;
}

/** A stub Harper (node runs it; it prints a marker and exits). */
function stubHarper(root: string): string {
  const p = join(root, "stub-harper.js");
  writeFileSync(p, `console.log(${JSON.stringify(MARKER)});\n`);
  return p;
}

/** A live, unrelated process (`sleep 60`). Returns its pid. */
function startSleep(): number {
  const proc = Bun.spawn(["sleep", "60"], { stdout: "ignore", stderr: "ignore" });
  pids.push(proc.pid);
  return proc.pid;
}

/** A live process whose command line is `node …/harper.js` (the direct process shape). */
function startNodeHarper(root: string): number {
  const script = join(root, "harper.js");
  writeFileSync(script, "setInterval(() => {}, 1000);\n");
  const proc = Bun.spawn(["node", script], { stdout: "ignore", stderr: "ignore" });
  pids.push(proc.pid);
  return proc.pid;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Wait until the pid is alive and its start time is readable (bounded). */
async function waitStarted(pid: number): Promise<number> {
  for (let i = 0; i < 100; i++) {
    const t = readProcessStartTimeMs(pid);
    if (alive(pid) && t !== null) return t;
    await Bun.sleep(20);
  }
  throw new Error(`pid ${pid} did not start with a readable start time`);
}

function writeSidecar(root: string, pid: number, startTimeMs: number): void {
  writeFileSync(join(root, "flair-daemon.json"), `${JSON.stringify({ pid, startTimeMs, port: 9926, flairVersion: "test" })}\n`);
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

function runLauncher(root: string, node: string, harperBin: string): { status: number | null; stdout: string; stderr: string } {
  const passFile = join(root, "admin-pass");
  writeFileSync(passFile, "not-a-real-secret\n", { mode: 0o600 });
  chmodSync(passFile, 0o600);
  const r = spawnSync("sh", [LAUNCHER, passFile, node, harperBin], {
    encoding: "utf-8",
    timeout: 20_000,
    env: childEnv(root),
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

afterEach(() => {
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("isNodeHarperCommandLine", () => {
  test("accepts node running harper.js, rejects anything else", () => {
    expect(isNodeHarperCommandLine("node /opt/flair/node_modules/harper/dist/bin/harper.js run .")).toBe(true);
    expect(isNodeHarperCommandLine("/usr/local/bin/node harper.js run .")).toBe(true);
    expect(isNodeHarperCommandLine("sleep 60")).toBe(false);
    expect(isNodeHarperCommandLine("bun /opt/flair/harper.js run .")).toBe(false);
    expect(isNodeHarperCommandLine("")).toBe(false);
  });
});

describe("flair#2056 — the launchd launcher identifies the process behind hdb.pid", () => {
  test("hdb.pid names a live UNRELATED process -> the launcher execs Harper", async () => {
    const root = mkRoot();
    const pid = startSleep();
    await waitStarted(pid);
    writeFileSync(join(root, "hdb.pid"), `${pid}\n`);
    const r = runLauncher(root, "node", stubHarper(root));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(MARKER);
    expect(r.stderr).not.toContain("already served");
  }, 30_000);

  test("CONTROL: the real direct process with a matching sidecar is refused", async () => {
    const root = mkRoot();
    const pid = startNodeHarper(root);
    const start = await waitStarted(pid);
    writeSidecar(root, pid, start);
    writeFileSync(join(root, "hdb.pid"), `${pid}\n`);
    const r = runLauncher(root, "node", stubHarper(root));
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain(MARKER);
    expect(r.stderr).toContain(`already served by pid ${pid}`);
  }, 30_000);

  test("a matching sidecar with a non-node/harper command line is unidentifiable -> proceed", async () => {
    const root = mkRoot();
    const pid = startSleep();
    const start = await waitStarted(pid);
    writeSidecar(root, pid, start); // matches pid + start time, but it is `sleep`
    writeFileSync(join(root, "hdb.pid"), `${pid}\n`);
    const r = runLauncher(root, "node", stubHarper(root));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(MARKER);
  }, 30_000);

  test("a start-time mismatch does not refuse (identity is the pair, not the pid)", async () => {
    const root = mkRoot();
    const pid = startNodeHarper(root);
    const start = await waitStarted(pid);
    writeSidecar(root, pid, start + 60_000);
    writeFileSync(join(root, "hdb.pid"), `${pid}\n`);
    const r = runLauncher(root, "node", stubHarper(root));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(MARKER);
  }, 30_000);
});

describe("flair#2056 — resolveInstanceServingPid applies the same identity rule", () => {
  test("a live unrelated pid in hdb.pid is not the serving process", async () => {
    const root = mkRoot();
    const pid = startSleep();
    await waitStarted(pid);
    writeFileSync(join(root, "hdb.pid"), `${pid}\n`);
    const serving = resolveInstanceServingPid(root, await freePort());
    expect(serving).not.toBe(pid);
    expect(serving).toBeNull();
  }, 30_000);

  test("CONTROL: the real direct process with a matching sidecar is returned", async () => {
    const root = mkRoot();
    const pid = startNodeHarper(root);
    const start = await waitStarted(pid);
    writeSidecar(root, pid, start);
    writeFileSync(join(root, "hdb.pid"), `${pid}\n`);
    const serving = resolveInstanceServingPid(root, await freePort());
    expect(serving).toBe(pid);
  }, 30_000);
});
