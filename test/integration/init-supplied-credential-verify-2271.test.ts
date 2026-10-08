import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ensureCliBuild } from "../helpers/build-cli-once.js";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const CLI = join(REPO_ROOT, "dist", "cli.js");
const SKIP_EXTRAS = [
  "--no-mcp",
  "--skip-soul",
  "--skip-smoke",
  "--skip-hook",
  "--skip-claude-md",
] as const;
const ADMIN_USER = "admin";
const ROTATE_REMEDY = "flair init --reset-admin-pass";

let root: string;
let home: string;
let dataDir: string;
let adminPassPath: string;
let httpPort: number;
let opsPort: number;
let installedPassword: string;
let savedUmask: number;

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

/** The CLI runs under Node, as an installed `flair` does (Harper's native modules). */
function nodeBin(): string {
  if (process.execPath && !process.execPath.includes("bun")) return process.execPath;
  return "node";
}

function runInit(args: string[], extraEnv: Record<string, string | undefined> = {}): Promise<Run> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(nodeBin(), [CLI, "init", ...args], {
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

function baseArgs(): string[] {
  return ["--data-dir", dataDir, "--port", String(httpPort), "--ops-port", String(opsPort), "--skip-start", ...SKIP_EXTRAS];
}

/** How a credential is supplied: the flag, the pass-file flag, or the env. */
function credential(source: "inline" | "file" | "FLAIR_ADMIN_PASS" | "HDB_ADMIN_PASSWORD", password: string): { args: string[]; env: Record<string, string> } {
  if (source === "inline") return { args: ["--admin-pass", password], env: {} };
  if (source === "file") {
    const input = join(home, "supplied-pass");
    writeFileSync(input, password + "\n", { mode: 0o600 });
    return { args: ["--admin-pass-file", input], env: {} };
  }
  return { args: [], env: { [source]: password } };
}

async function adminStatus(password: string): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${httpPort}/FederationPeers`, {
    headers: { Authorization: "Basic " + Buffer.from(`${ADMIN_USER}:${password}`).toString("base64") },
    signal: AbortSignal.timeout(10_000),
  });
  return res.status;
}

beforeAll(() => {
  // init attributes the running instance by its group/world-writable checks, so
  // the fixture must create the pid file with a 022 umask (CI's default); a
  // group-writable hdb.pid is refused before the credential block.
  savedUmask = process.umask(0o022);
  ensureCliBuild();
  root = mkdtempSync(join(tmpdir(), "flair-2271-"));
  home = join(root, "home");
  dataDir = join(root, "data");
  adminPassPath = join(home, ".flair", "admin-pass");
  httpPort = freePort();
  opsPort = freePort();
}, 150_000);

afterAll(() => {
  try { stopHarper(); } catch { /* best effort */ }
  if (root) rmSync(root, { recursive: true, force: true });
  process.umask(savedUmask);
});

describe.skipIf(process.platform !== "linux")("flair#2271 — supplied credentials on an existing install", () => {
  test("a real init establishes a running instance with a working admin-pass", async () => {
    mkdirSync(home, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(join(home, ".flair"), { recursive: true });
    symlinkSync(dataDir, join(home, ".flair", "data"));
    const r = await runInit(["--data-dir", dataDir, "--port", String(httpPort), "--ops-port", String(opsPort), ...SKIP_EXTRAS]);
    expect(r.code, r.out).toBe(0);
    expect(existsSync(adminPassPath)).toBe(true);
    installedPassword = readFileSync(adminPassPath, "utf8").trim();
    expect(installedPassword.length).toBeGreaterThan(0);
    expect(await adminStatus(installedPassword)).toBe(200);
  }, 180_000);

  for (const source of ["inline", "file", "FLAIR_ADMIN_PASS", "HDB_ADMIN_PASSWORD"] as const) {
    test(`${source}: a wrong credential is refused and admin-pass stays byte-identical`, async () => {
      const before = readFileSync(adminPassPath);
      const { args, env } = credential(source, "fixture-wrong-credential-2271");
      const r = await runInit([...baseArgs(), ...args], env);
      expect(r.code, r.out).not.toBe(0);
      expect(r.out).toContain("the supplied admin credential was rejected (HTTP ");
      expect(r.out).toContain(ROTATE_REMEDY);
      expect(readFileSync(adminPassPath).equals(before)).toBe(true);
      expect(await adminStatus(installedPassword)).toBe(200);
    }, 150_000);

    test(`${source}: a correct credential proceeds`, async () => {
      const { args, env } = credential(source, installedPassword);
      const r = await runInit([...baseArgs(), ...args], env);
      expect(r.code, r.out).toBe(0);
      expect(readFileSync(adminPassPath, "utf8")).toBe(installedPassword + "\n");
    }, 150_000);
  }

  test("a running Harper install without a pass file refuses a wrong supplied credential", async () => {
    const before = readFileSync(adminPassPath);
    rmSync(adminPassPath);
    try {
      const { args, env } = credential("file", "fixture-wrong-credential-2271");
      const r = await runInit([...baseArgs(), ...args], env);
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain(`Refusing to write ${adminPassPath}: the supplied admin credential was rejected (HTTP `);
      expect(r.out).toContain("No pass file was written; any existing file is unchanged.");
      expect(r.out).toContain(ROTATE_REMEDY);
      expect(existsSync(adminPassPath)).toBe(false);
      expect(await adminStatus(installedPassword)).toBe(200);
    } finally {
      writeFileSync(adminPassPath, before, { mode: 0o600 });
    }
  }, 150_000);

  test("FLAIR_ADMIN_USER cannot substitute another superuser's password", async () => {
    const alternate = "fixture-alternate-superuser-2271";
    const response = await fetch(`http://127.0.0.1:${opsPort}/`, {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`admin:${installedPassword}`).toString("base64"),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ operation: "add_user", username: "alternate-2271", password: alternate, role: "super_user", active: true }),
      signal: AbortSignal.timeout(10_000),
    });
    expect(response.status).toBe(200);
    const accepted = await fetch(`http://127.0.0.1:${httpPort}/FederationPeers`, {
      headers: { Authorization: "Basic " + Buffer.from(`alternate-2271:${alternate}`).toString("base64") },
      signal: AbortSignal.timeout(10_000),
    });
    expect(accepted.status).toBe(200);
    const before = readFileSync(adminPassPath);
    const r = await runInit([...baseArgs(), "--admin-pass", alternate], { FLAIR_ADMIN_USER: "alternate-2271" });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain(ROTATE_REMEDY);
    expect(readFileSync(adminPassPath).equals(before)).toBe(true);
    expect(await adminStatus(installedPassword)).toBe(200);
  }, 180_000);

  test("--reset-admin-pass still rotates and the new credential authenticates", async () => {
    const rotated = "fixture-rotated-admin-2271";
    const before = readFileSync(adminPassPath);
    const r = await runInit([...baseArgs(), "--reset-admin-pass", "--admin-pass", rotated]);
    expect(r.code, r.out).toBe(0);
    expect(readFileSync(adminPassPath, "utf8")).toBe(rotated + "\n");
    expect(readFileSync(adminPassPath).equals(before)).toBe(false);
    expect(await adminStatus(rotated)).toBe(200);
    installedPassword = rotated;
  }, 150_000);

  describe("stopped Harper install", () => {
    beforeAll(() => stopHarper());
    for (const skipStart of [false, true]) {
      for (const source of ["inline", "file", "FLAIR_ADMIN_PASS", "HDB_ADMIN_PASSWORD"] as const) {
        test(`${source}: refuses a supplied credential, skip-start=${skipStart}`, async () => {
          const before = readFileSync(adminPassPath);
          const { args, env } = credential(source, "fixture-stopped-wrong-2271");
          const initArgs = skipStart ? baseArgs() : baseArgs().filter(arg => arg !== "--skip-start");
          const r = await runInit([...initArgs, ...args], env);
          expect(r.code).not.toBe(0);
          expect(r.out).toContain("no running instance; a saved admin-pass file or persisted admin user exists");
          expect(r.out).toContain("Start the instance and re-run");
          expect(r.out).toContain(ROTATE_REMEDY);
          expect(readFileSync(adminPassPath).equals(before)).toBe(true);
        }, 150_000);
      }
    }
    for (const source of ["inline", "file", "FLAIR_ADMIN_PASS", "HDB_ADMIN_PASSWORD"] as const) {
      test(`${source}: stopped config-only init preserves an identical saved credential`, async () => {
        const before = readFileSync(adminPassPath);
        const { args, env } = credential(source, installedPassword);
        const r = await runInit([...baseArgs(), "--agent", "stopped-config-2271", ...args], env);
        expect(r.code, r.out).toBe(0);
        expect(r.out).toContain("Agent registration deferred");
        expect(r.out).not.toContain("verified");
        expect(readFileSync(adminPassPath).equals(before)).toBe(true);
        expect(existsSync(join(home, ".flair", "keys", "stopped-config-2271.key"))).toBe(true);
      }, 150_000);
    }
    test("a persisted admin without a pass file refuses a supplied credential", async () => {
      rmSync(adminPassPath);
      const r = await runInit([...baseArgs(), "--admin-pass", installedPassword]);
      expect(r.code).not.toBe(0);
      expect(r.out).toContain("Start the instance and re-run");
      expect(r.out).toContain(ROTATE_REMEDY);
      expect(existsSync(adminPassPath)).toBe(false);
    }, 150_000);
  });

});
