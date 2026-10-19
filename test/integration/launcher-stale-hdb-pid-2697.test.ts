// launcher-stale-hdb-pid-2697.test.ts — flair#2697 against a REAL Harper.
//
// The product launchd launcher (templates/launchd/start-flair-with-admin-pass.sh)
// run directly, without launchctl, with the node_modules Harper and this
// checkout as the application, on ephemeral ports in a temporary ROOTPATH and
// HOME. One case, in order:
//
//   (c) Harper started through the launcher by a node whose path contains a
//       space. The launcher's ps parse does not see that line as Harper-shaped,
//       but the line contains `harper`, so a second launcher run leaves hdb.pid
//       in place and Harper's own check exits 4: no second instance starts.
//   (b) That Harper is SIGKILLed (hdb.pid stays behind) and hdb.pid is pointed
//       at a live, unrelated process. The launcher moves hdb.pid aside and the
//       Harper it execs serves and writes its own pid to hdb.pid.
//   (a) A launcher run while that Harper lives is refused (exit 0) and leaves
//       hdb.pid in place.
//
// Every process this file signals is one it spawned, by the pid it recorded.
// Harper runs with the flair#1450 orphan-exit preload, so it exits if this
// process dies. Skipped when HARPER_HTTP_URL is set (no local spawn).
import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { applyOrphanExitPreload } from "../helpers/harper-lifecycle.ts";
import { assertFlairDistFresh } from "../helpers/dist-freshness.ts";
import { isHarperProcessCommandLine } from "../../src/lib/daemon-liveness.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const LAUNCHER = join(REPO_ROOT, "templates", "launchd", "start-flair-with-admin-pass.sh");
const HARPER_BIN = join(REPO_ROOT, "node_modules", "harper", "dist", "bin", "harper.js");
const external = process.env.HARPER_HTTP_URL !== undefined;
if (external) console.log("launcher-stale-hdb-pid-2697: skipped; HARPER_HTTP_URL is set; requires a locally spawned Harper");

const CASE_BUDGET_MS = 420_000;
const READY_BUDGET_MS = 120_000;
const ADMIN_PASS = "test123";
const REFUSAL = "whose command line as ps reports it is node or bun followed by a Harper entry path; not starting a second instance";

const spawned: ChildProcess[] = [];
let root = "";

afterAll(() => {
  for (const proc of spawned) {
    if (proc.pid !== undefined && proc.exitCode === null && proc.signalCode === null) {
      try {
        process.kill(proc.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
  if (root) rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

/** This host's node, as an absolute path (Harper's native modules need node, not bun). */
function nodeBin(): string {
  if (process.env.NODE_BIN) return process.env.NODE_BIN;
  const p = Bun.which("node") ?? "";
  if (!p.startsWith("/")) throw new Error("node is not on PATH");
  return p;
}

async function freePorts(count: number): Promise<number[]> {
  const servers = await Promise.all(
    Array.from({ length: count }, () =>
      new Promise<ReturnType<typeof createServer>>((res, rej) => {
        const srv = createServer();
        srv.once("error", rej);
        srv.listen(0, "127.0.0.1", () => res(srv));
      }),
    ),
  );
  const ports = servers.map((s) => (s.address() as { port: number }).port);
  await Promise.all(servers.map((s) => new Promise<void>((res) => s.close(() => res()))));
  return ports;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The pid Harper reads from hdb.pid (Number.parseInt), or null when there is no file. */
function hdbPid(dataDir: string): number | null {
  const f = join(dataDir, "hdb.pid");
  if (!existsSync(f)) return null;
  const n = Number.parseInt(readFileSync(f, "utf-8"), 10);
  return Number.isNaN(n) ? null : n;
}

function staleCopies(dataDir: string): string[] {
  return readdirSync(dataDir).filter((n) => n.startsWith("hdb.pid.stale-")).sort();
}

function psCommand(pid: number): string {
  return spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf-8", timeout: 5_000 }).stdout.trim();
}

function launcherLines(text: string): string[] {
  return text.split("\n").filter((l) => l.startsWith("start-flair-with-admin-pass:"));
}

async function healthStatus(httpPort: number): Promise<number | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${httpPort}/Health`, { signal: AbortSignal.timeout(2_000) });
    return res.status;
  } catch {
    return null;
  }
}

test.skipIf(external)(
  "the launcher keeps a live Harper's hdb.pid (shape check or not), moves one naming an unrelated live process, and the Harper it then execs serves",
  async () => {
    assertFlairDistFresh(REPO_ROOT);
    expect(existsSync(HARPER_BIN)).toBe(true);
    const node = nodeBin();
    root = mkdtempSync(join(tmpdir(), "fl2697-it-"));
    const dataDir = join(root, "data");
    const homeDir = join(root, "home");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    const passFile = join(root, "admin-pass");
    writeFileSync(passFile, `${ADMIN_PASS}\n`, { mode: 0o600 });
    chmodSync(passFile, 0o600);
    const spaceNodeDir = join(root, "node bin dir");
    mkdirSync(spaceNodeDir);
    const spaceNode = join(spaceNodeDir, "node");
    symlinkSync(node, spaceNode);

    const ambient: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined || /^(FLAIR_|HARPER_|HDB_|TPS_|FABRIC_)/.test(k)) continue;
      ambient[k] = v;
    }
    const base: Record<string, string> = {
      ...ambient,
      ROOTPATH: dataDir,
      HOME: homeDir,
      FLAIR_MODELS_DIR: process.env.FLAIR_MODELS_DIR ?? join(REPO_ROOT, "models"),
      DEFAULTS_MODE: "dev",
      HDB_ADMIN_USERNAME: "admin",
      THREADS_COUNT: "1",
      NODE_HOSTNAME: "127.0.0.1",
      MQTT_NETWORK_PORT: "null",
      MQTT_NETWORK_SECUREPORT: "null",
      MQTT_WEBSOCKET: "false",
      THREADS_DEBUG: "false",
    };
    // The launcher is `sh` running a script that execs the node passed to it
    // (this host's node, or a symlink to it), so the bun-harper spawn guard
    // needs a reason for these launches.
    const runEnv = (httpPort: number, opsPort: number): Record<string, string> =>
      applyOrphanExitPreload({
        ...base,
        HTTP_PORT: `127.0.0.1:${httpPort}`,
        OPERATIONSAPI_NETWORK_PORT: String(opsPort),
        FLAIR_TEST_ALLOW_BUN_HARPER: "run the product launchd launcher, which execs the node binary it is given",
      });

    const install = spawnSync(node, [HARPER_BIN, "install"], {
      cwd: REPO_ROOT,
      env: { ...base, HDB_ADMIN_PASSWORD: ADMIN_PASS },
      encoding: "utf-8",
      timeout: 90_000,
    });
    expect(install.status, `harper install: ${install.stdout}\n${install.stderr}`).toBe(0);

    /** Start the launcher in the background; resolves once its Harper answers /Health. */
    async function launchAndServe(nodePath: string): Promise<{ proc: ChildProcess; httpPort: number; output: () => string }> {
      const [httpPort, opsPort] = await freePorts(2);
      const proc = spawn("sh", [LAUNCHER, passFile, nodePath, HARPER_BIN], { cwd: REPO_ROOT, env: runEnv(httpPort, opsPort), stdio: ["ignore", "pipe", "pipe"] });
      spawned.push(proc);
      let out = "";
      proc.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
      proc.stderr?.on("data", (d: Buffer) => { out += d.toString(); });
      const deadline = Date.now() + READY_BUDGET_MS;
      for (;;) {
        if (proc.exitCode !== null || proc.signalCode !== null) {
          throw new Error(`the launcher's Harper exited (code ${proc.exitCode}, signal ${proc.signalCode}) before serving /Health:\n${out}`);
        }
        const status = await healthStatus(httpPort);
        if (status === 200 || status === 401) break;
        if (Date.now() > deadline) throw new Error(`the launcher's Harper did not serve /Health within ${READY_BUDGET_MS} ms:\n${out}`);
        await Bun.sleep(500);
      }
      // Harper writes hdb.pid during startup; give it a moment when /Health answers first.
      for (let i = 0; i < 50 && hdbPid(dataDir) !== proc.pid; i++) await Bun.sleep(100);
      return { proc, httpPort, output: () => out };
    }

    /** One launcher run in the foreground, on ports of its own. */
    async function launchOnce(nodePath: string): Promise<{ status: number | null; output: string }> {
      const [httpPort, opsPort] = await freePorts(2);
      const r = spawnSync("sh", [LAUNCHER, passFile, nodePath, HARPER_BIN], {
        cwd: REPO_ROOT,
        env: runEnv(httpPort, opsPort),
        encoding: "utf-8",
        timeout: 90_000,
        killSignal: "SIGKILL",
      });
      return { status: r.status, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
    }

    // (c) A Harper whose node path contains a space.
    const c = await launchAndServe(spaceNode);
    const pidC = c.proc.pid as number;
    expect(hdbPid(dataDir)).toBe(pidC);
    const lineC = psCommand(pidC);
    expect(lineC).toContain("/node bin dir/node ");
    expect(isHarperProcessCommandLine(lineC)).toBe(false); // the shape check alone would call it unrelated
    const secondC = await launchOnce(node);
    expect(launcherLines(secondC.output)).toEqual([]); // neither refused nor moved
    expect(secondC.output).toContain(`Harper is already running (pid: ${pidC})`);
    expect(secondC.status).toBe(4);
    expect(hdbPid(dataDir)).toBe(pidC);
    expect(staleCopies(dataDir)).toEqual([]);
    expect([200, 401]).toContain((await healthStatus(c.httpPort)) ?? 0);

    // (b) SIGKILL leaves hdb.pid behind; point it at a live, unrelated process.
    process.kill(pidC, "SIGKILL");
    for (let i = 0; i < 100 && alive(pidC); i++) await Bun.sleep(50);
    expect(alive(pidC)).toBe(false);
    expect(hdbPid(dataDir)).toBe(pidC);
    const sleeper = spawn("sleep", ["300"], { stdio: "ignore" });
    spawned.push(sleeper);
    const sleepPid = sleeper.pid as number;
    for (let i = 0; i < 100 && psCommand(sleepPid) === ""; i++) await Bun.sleep(20);
    writeFileSync(join(dataDir, "hdb.pid"), `${sleepPid}\n`);
    const b = await launchAndServe(node);
    const pidB = b.proc.pid as number;
    const moved = launcherLines(b.output());
    expect(moved.length).toBe(1);
    expect(moved[0]).toContain(`hdb.pid names pid ${sleepPid}, a live process that is not this instance`);
    expect(moved[0]).toContain("; moved hdb.pid to ");
    const stale = staleCopies(dataDir);
    expect(stale.length).toBe(1);
    expect(readFileSync(join(dataDir, stale[0]), "utf-8")).toBe(`${sleepPid}\n`);
    expect(hdbPid(dataDir)).toBe(pidB);
    expect(alive(sleepPid)).toBe(true);

    // (a) A launcher run while that Harper lives is refused and keeps its hdb.pid.
    expect(isHarperProcessCommandLine(psCommand(pidB))).toBe(true);
    const secondB = await launchOnce(node);
    expect(secondB.status).toBe(0);
    expect(launcherLines(secondB.output)).toEqual([expect.stringContaining(`hdb.pid names pid ${pidB}, ${REFUSAL}`)]);
    expect(hdbPid(dataDir)).toBe(pidB);
    expect(staleCopies(dataDir)).toEqual(stale);
    expect([200, 401]).toContain((await healthStatus(b.httpPort)) ?? 0);
  },
  CASE_BUDGET_MS,
);
