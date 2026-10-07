/**
 * flair#2210 — the persisted-admin detector on a REAL Harper 5 data directory.
 *
 * `flair init` on Harper 5 must see the admin user Harper actually persisted
 * (a row in the system database's `hdb_user/` RocksDB column family), not read
 * the install as fresh. These run a real `flair init` in a throwaway HOME and
 * data dir on ephemeral ports, then assert the detector and the two decisions
 * that depend on it: the `persisted-missing-file` refusal when the admin-pass
 * file is gone, and re-persist when an explicit credential is supplied.
 *
 * No real ~/.flair is touched: HOME is a temp dir, the data dir is explicit,
 * and the ports are free ports picked at run time.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ensureCliBuild } from "../helpers/build-cli-once.js";
import { seedAgentViaOpsApi } from "../../src/cli.js";
import { detectPersistedAdminUser } from "../../src/lib/init-admin-pass.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const CLI = join(REPO_ROOT, "dist", "cli.js");

const SKIP_EXTRAS = [
  "--no-mcp",
  "--skip-soul",
  "--skip-smoke",
  "--skip-hook",
  "--skip-claude-md",
] as const;

let root: string;
let home: string;
let dataDir: string;
let adminPassPath: string;
let httpPort: number;
let opsPort: number;
let installedPassword: string;

function freePort(): number {
  const r = spawnSync(
    process.execPath,
    ["-e", "const n=require('net');const s=n.createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close();});"],
    { encoding: "utf-8", timeout: 5_000 },
  );
  const port = Number((r.stdout ?? "").trim());
  if (!Number.isInteger(port) || port <= 0) throw new Error(`could not pick a free port: ${r.stdout}`);
  return port;
}

function initEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.TPS_TEST_ROOT;
  for (const key of [
    "FLAIR_ADMIN_PASS",
    "HDB_ADMIN_PASSWORD",
    "FLAIR_URL",
    "FLAIR_TARGET",
    "FLAIR_OPS_PORT",
    "FLAIR_OPS_TARGET",
    "FLAIR_ADMIN_USER",
    "FLAIR_SOCKET_GROUP",
    "FLAIR_MODELS_DIR",
    "ROOTPATH",
  ]) {
    delete env[key];
  }
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

interface Run {
  code: number | null;
  out: string;
}

function runInit(args: string[], extraEnv: Record<string, string | undefined> = {}): Promise<Run> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [CLI, "init", ...args], {
      cwd: REPO_ROOT,
      env: initEnv(extraEnv),
      stdio: ["ignore", "pipe", "pipe"],
      // Numeric literal: check-cli-spawn-budgets does not read CLI_DEADLINE_MS.
      timeout: 120_000,
      killSignal: "SIGTERM",
    });
    let out = "";
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.stderr?.on("data", (d) => (out += d.toString()));
    child.on("error", (err) => reject(err));
    child.on("close", (code, signal) => {
      if (signal !== null) {
        reject(new Error(`flair init overran its deadline (signal ${signal}):\n${out.slice(-4000)}`));
        return;
      }
      resolvePromise({ code, out });
    });
  });
}

/** Stop the Harper this init started (my own pid, from its own pid file). */
function stopHarper(): void {
  const pidFile = join(dataDir, "hdb.pid");
  if (!existsSync(pidFile)) return;
  const pid = Number.parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) return;
  try { process.kill(pid, "SIGTERM"); } catch { return; }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return; }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
}

beforeAll(() => {
  ensureCliBuild();
  root = mkdtempSync(join(tmpdir(), "flair-2210-"));
  home = join(root, "home");
  dataDir = join(root, "data");
  adminPassPath = join(home, ".flair", "admin-pass");
  httpPort = freePort();
  opsPort = freePort();
}, 150_000);

afterAll(() => {
  try { stopHarper(); } catch { /* best effort */ }
  if (root) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform !== "linux")("fresh explicit credentials on a real Harper install", () => {
  for (const source of ["inline", "file", "FLAIR_ADMIN_PASS", "HDB_ADMIN_PASSWORD"] as const) {
    test(`${source}: persists 0600 and doctor reports no admin-pass desync`, async () => {
      stopHarper();
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
      mkdirSync(home, { recursive: true });
      mkdirSync(dataDir, { recursive: true });
      mkdirSync(join(home, ".flair"), { recursive: true });
      symlinkSync(dataDir, join(home, ".flair", "data"));
      const password = "fixture-fresh-explicit-password";
      const args = ["--data-dir", dataDir, "--port", String(httpPort), "--ops-port", String(opsPort), ...SKIP_EXTRAS];
      const env: Record<string, string> = {};
      if (source === "inline") args.push("--admin-pass", password);
      else if (source === "file") {
        const input = join(home, "input-pass");
        writeFileSync(input, password + "\n", { mode: 0o600 });
        args.push("--admin-pass-file", input);
      } else env[source] = password;
      const result = await runInit(args, env);
      expect(result.code, result.out).toBe(0);
      expect(readFileSync(adminPassPath, "utf8")).toBe(password + "\n");
      expect(statSync(adminPassPath).mode & 0o777).toBe(0o600);
      expect(detectPersistedAdminUser(dataDir)).toBe(true);
      expect(realpathSync(join(home, ".flair", "data"))).toBe(realpathSync(dataDir));
      const doctor = spawnSync(process.execPath, [CLI, "doctor", "--port", String(httpPort)], {
        cwd: REPO_ROOT, env: initEnv(), encoding: "utf8", timeout: 30_000,
      });
      expect(doctor.error).toBeUndefined();
      expect(doctor.signal).toBeNull();
      expect(doctor.stdout).toContain("Flair Doctor");
      expect(doctor.stdout).not.toContain("admin-pass file missing");
      expect(doctor.stdout).not.toContain("not assessing the admin-pass desync");
    }, 180_000);
  }
});

describe("flair#2210 — a real Harper 5 install is not read as fresh", () => {
  test("a real `flair init` creates a data dir the detector reads as a persisted admin user", async () => {
    stopHarper();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(join(home, ".flair"), { recursive: true });
    symlinkSync(dataDir, join(home, ".flair", "data"));
    const firstRun = await runInit([
      "--data-dir", dataDir,
      "--port", String(httpPort),
      "--ops-port", String(opsPort),
      ...SKIP_EXTRAS,
    ]);
    expect(firstRun.code, `flair init failed:\n${firstRun.out.slice(-4000)}`).toBe(0);
    expect(existsSync(adminPassPath)).toBe(true);
    installedPassword = readFileSync(adminPassPath, "utf8").trim();
    // The real data dir has Harper's persisted admin user (RocksDB hdb_user/).
    expect(detectPersistedAdminUser(dataDir)).toBe(true);
  }, 150_000);

  test("real Harper operations 401 gives a credential remedy", async () => {
    const readListener = () => ({
      port: opsPort,
      pids: [Number(readFileSync(join(dataDir, "hdb.pid"), "utf8").trim())],
      dataDirs: [dataDir],
    });
    let message = "";
    try {
      await seedAgentViaOpsApi(opsPort, "wrong-password-fixture", "pubkey", "admin", "fixture-wrong-password", {
        before: readListener(),
        reread: readListener,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("Operations API insert failed (401)");
    expect(message).toContain("check the admin password for this data directory");
    expect(message).not.toContain("free the port");
    expect(message).not.toContain("choose --port");
    expect(message).not.toMatch(/\bkill \d+/);
  });

  test("admin-pass removed: `flair init` refuses with the persisted-missing-file message and writes nothing", async () => {
    stopHarper();
    rmSync(adminPassPath, { force: true });
    expect(existsSync(adminPassPath)).toBe(false);

    const r = await runInit([
      "--data-dir", dataDir,
      "--port", String(httpPort),
      "--ops-port", String(opsPort),
      "--skip-start",
      ...SKIP_EXTRAS,
    ]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("already has an admin user");
    expect(r.out).toContain("flair init --admin-pass-file <path>");
    expect(r.out).toContain("flair init --reset-admin-pass");
    // Refused BEFORE any write.
    expect(existsSync(adminPassPath)).toBe(false);
  }, 150_000);

  test("a stopped Harper 5 install refuses an explicit credential", async () => {
    const r = await runInit([
      "--data-dir", dataDir,
      "--port", String(httpPort),
      "--ops-port", String(opsPort),
      "--skip-start",
      "--admin-pass", installedPassword,
      ...SKIP_EXTRAS,
    ]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("Start the instance and re-run");
    expect(r.out).toContain("flair init --reset-admin-pass");
    expect(existsSync(adminPassPath)).toBe(false);
  }, 150_000);
});
