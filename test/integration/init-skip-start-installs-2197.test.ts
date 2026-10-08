// Local init --skip-start on a stopped default instance with free ports.
// The rerun checks Harper's config contents.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { ensureCliBuild } from "../helpers/build-cli-once.js";
import { SEED_ASSIGNMENT_ID, SEED_SKILL_ID } from "../../src/lib/skill-seed.js";
import { skillSeedPendingPath } from "../../src/lib/skill-seed-pending.js";

const ROOT = resolve(import.meta.dirname, "..", "..");
const CLI = join(ROOT, "dist", "cli.js");
const ADMIN_USER = "admin";
const ADMIN_PASS = `skip-start-${randomUUID()}`;

const INSTANCE_READY_TIMEOUT_MS = 30_000;
const TEARDOWN_TIMEOUT_MS = 60_000;

interface Install {
  home: string;
  dataDir: string;
  httpPort: number;
  opsPort: number;
}

const installs: Install[] = [];

/** Two distinct free ports: both listeners stay open until both ports are known. */
async function freePorts(): Promise<[number, number]> {
  const open = () =>
    new Promise<ReturnType<typeof createServer>>((resolveServer, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolveServer(server));
    });
  const servers = [await open(), await open()];
  const ports = servers.map((server) => {
    const address = server.address();
    return typeof address === "object" && address ? address.port : 0;
  });
  await Promise.all(servers.map((server) => new Promise((r) => server.close(() => r(null)))));
  return [ports[0], ports[1]];
}

function childEnv(home: string, shimDir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^(FLAIR_|HARPER_|HDB_|FABRIC_)/.test(k)) continue;
    env[k] = v;
  }
  env.HOME = home;
  env.PATH = `${shimDir}:${process.env.PATH ?? ""}`;
  env.FLAIR_MODELS_DIR = process.env.FLAIR_MODELS_DIR ?? join(ROOT, "models");
  return env;
}

function launchctlStub(home: string): string {
  const dir = join(home, "test-bin");
  mkdirSync(dir, { recursive: true });
  const stub = join(dir, "launchctl");
  writeFileSync(stub, '#!/bin/sh\necho "Could not find service (test stub; the real launchctl is not called)" >&2\nexit 113\n');
  chmodSync(stub, 0o755);
  return dir;
}

async function newInstall(): Promise<Install> {
  // Short prefix: <HOME>/.flair/data/operations-server must fit the 103-byte socket limit.
  const [httpPort, opsPort] = await freePorts();
  const home = mkdtempSync(join(tmpdir(), "fss-"));
  const install: Install = { home, dataDir: join(home, ".flair", "data"), httpPort, opsPort };
  expect(httpPort).not.toBe(opsPort);
  for (const port of [httpPort, opsPort]) expect(["9925", "9926"]).not.toContain(String(port));
  installs.push(install);
  return install;
}

/** The CLI runs under Node, as an installed `flair` does (Harper's native modules). */
function nodeBin(): string {
  if (process.env.NODE_BIN) return process.env.NODE_BIN;
  if (process.execPath && !process.execPath.includes("bun")) return process.execPath;
  return "node";
}

function runLocalInit(install: Install, extraArgs: string[], cwd = ROOT, supplyCredential = true) {
  const startedAt = Date.now();
  const res = spawnSync(
    nodeBin(),
    [CLI, "init", "--port", String(install.httpPort), "--ops-port", String(install.opsPort), ...(supplyCredential ? ["--admin-pass", ADMIN_PASS] : []),
      "--skip-soul", "--no-mcp", "--skip-smoke", "--skip-claude-md", "--skip-hook", ...extraArgs],
    {
      cwd,
      encoding: "utf8",
      timeout: 120_000,
      killSignal: "SIGKILL",
      env: childEnv(install.home, launchctlStub(install.home)),
    },
  );
  return { status: res.status, signal: res.signal, stdout: res.stdout ?? "", stderr: res.stderr ?? "", startedAt };
}

function runLocalService(install: Install, command: "start" | "stop", extraEnv: Record<string, string> = {}) {
  const startedAt = Date.now();
  const res = spawnSync(nodeBin(), [CLI, command, "--port", String(install.httpPort)], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 120_000,
    killSignal: "SIGKILL",
    env: { ...childEnv(install.home, launchctlStub(install.home)), ...extraEnv },
  });
  return { status: res.status, signal: res.signal, stdout: res.stdout ?? "", stderr: res.stderr ?? "", startedAt };
}

/** The installation Harper writes at install: its config file in the data dir. */
function installed(install: Install): boolean {
  return existsSync(join(install.dataDir, "harper-config.yaml"))
    || existsSync(join(install.dataDir, "harperdb-config.yaml"));
}

/** True when something answers on the port — used to prove "nothing is running". */
async function serves(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/Health`, { signal: AbortSignal.timeout(1_500) });
    return true;
  } catch {
    return false;
  }
}

/**
 * Wait until this test's instance is actually serving: HTTP `/Health` answers
 * 2xx or 401 AND the operations API answers a real request.
 */
async function waitForInstance(install: Install, startedAt: number): Promise<void> {
  const healthURL = `http://127.0.0.1:${install.httpPort}/Health`;
  const opsURL = `http://127.0.0.1:${install.opsPort}/`;
  const deadline = Date.now() + INSTANCE_READY_TIMEOUT_MS;
  let last = "no attempt yet";
  while (Date.now() < deadline) {
    try {
      const health = await fetch(healthURL, {
        headers: { Authorization: basic() },
        signal: AbortSignal.timeout(2_000),
      });
      if (health.ok || health.status === 401) {
        const res = await fetch(opsURL, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: basic() },
          body: JSON.stringify({ operation: "search_by_id", database: "flair", table: "Memory", ids: ["__readiness_probe__"], get_attributes: ["id"] }),
          signal: AbortSignal.timeout(5_000),
        });
        if (res.status === 200) return;
        last = `ops answered HTTP ${res.status}`;
      } else {
        last = `health HTTP ${health.status}`;
      }
    } catch (err: any) {
      last = err?.message ?? String(err);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `the instance (http ${install.httpPort}, ops ${install.opsPort}) was not serving within ` +
      `${INSTANCE_READY_TIMEOUT_MS}ms (measured startup ${Date.now() - startedAt}ms); last: ${last}`,
  );
}

const basic = () => "Basic " + Buffer.from(`${ADMIN_USER}:${ADMIN_PASS}`).toString("base64");

async function ops(install: Install, operation: Record<string, unknown>): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${install.opsPort}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basic() },
    body: JSON.stringify(operation),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  expect(res.status, `${operation.operation}: ${text.slice(0, 300)}`).toBe(200);
  return text.length > 0 ? JSON.parse(text) : undefined;
}

/** The seeded skill row and its org assignment, read through the ops API. */
async function seedRows(install: Install): Promise<{ rows: any[]; assignments: any[] }> {
  const rows = await ops(install, {
    operation: "search_by_id", database: "flair", table: "Memory", ids: [SEED_SKILL_ID],
    get_attributes: ["id", "agentId", "visibility"],
  });
  const assignments = await ops(install, {
    operation: "search_by_id", database: "flair", table: "OrgSkillAssignment", ids: [SEED_ASSIGNMENT_ID],
    get_attributes: ["id", "skillName", "skillRef"],
  });
  return { rows: Array.isArray(rows) ? rows : [], assignments: Array.isArray(assignments) ? assignments : [] };
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function stopInstall(install: Install): Promise<void> {
  const pidFile = join(install.dataDir, "hdb.pid");
  const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8").trim()) : NaN;
  if (Number.isInteger(pid) && pid > 0) {
    try { process.kill(pid, "SIGTERM"); } catch { /* gone */ }
    const deadline = Date.now() + 15_000;
    while (alive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    if (alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  }
  rmSync(install.home, { recursive: true, force: true });
}

describe("flair#2197 — local init --skip-start installs without starting", () => {
  beforeAll(() => ensureCliBuild(), 210_000);

  afterEach(async () => {
    while (installs.length > 0) await stopInstall(installs.pop() as Install);
  }, TEARDOWN_TIMEOUT_MS);

  test("an empty data directory: installs, stays stopped, queues first-start work, then `flair start` performs it", async () => {
    const install = await newInstall();

    const init = runLocalInit(install, ["--skip-start"]);
    expect(init.status, `init failed (signal ${init.signal}):\n${init.stdout.slice(-1500)}\n${init.stderr.slice(-1500)}`).toBe(0);

    // The installation exists ...
    expect(installed(install), "init --skip-start left no installation").toBe(true);
    // ... nothing is running ...
    expect(await serves(install.httpPort), "init --skip-start started Harper").toBe(false);
    expect(existsSync(join(install.dataDir, "hdb.pid")), "init --skip-start left a pidfile").toBe(false);
    // ... and first-start work is queued rather than performed.
    expect(existsSync(skillSeedPendingPath(install.dataDir))).toBe(true);
    expect(init.stdout).toContain("using-flair skill: pending");

    // A following `flair start` starts the instance and performs the deferred work.
    const start = runLocalService(install, "start", { FLAIR_ADMIN_PASS: ADMIN_PASS });
    expect(start.status, `start failed (signal ${start.signal}):\n${start.stdout.slice(-1500)}\n${start.stderr.slice(-1500)}`).toBe(0);
    expect(start.stdout).toContain("using-flair skill: seeded the using-flair skill");
    expect(existsSync(skillSeedPendingPath(install.dataDir)), "the deferred seed was not completed").toBe(false);

    await waitForInstance(install, start.startedAt);
    const { rows, assignments } = await seedRows(install);
    expect(rows[0]).toMatchObject({ id: SEED_SKILL_ID, agentId: ADMIN_USER, visibility: "shared" });
    expect(assignments[0]).toMatchObject({ id: SEED_ASSIGNMENT_ID, skillName: "using-flair", skillRef: SEED_SKILL_ID });
  }, 300_000);

  for (const { responds, existing, skipStart } of [
    { responds: true, existing: false, skipStart: true },
    { responds: false, existing: false, skipStart: true },
    { responds: true, existing: true, skipStart: true },
  ]) {
    test(`an occupied HTTP port in another data directory refuses without credentials (installed=${existing}, health response=${responds}, skip-start=${skipStart})`, async () => {
      const install = await newInstall();
      const foreignDataDir = join(install.home, "foreign-data");
      mkdirSync(foreignDataDir);
      const configPath = join(install.dataDir, "harper-config.yaml");
      const config = `rootPath: ${install.dataDir}\n`;
      if (existing) {
        mkdirSync(install.dataDir, { recursive: true });
        writeFileSync(configPath, config);
      }
      const log = join(install.home, "requests.jsonl");
      const script = `
        import { createServer } from "node:http";
        import { appendFileSync } from "node:fs";
        createServer((req, res) => {
          appendFileSync(${JSON.stringify(log)}, JSON.stringify({ url: req.url, authorization: req.headers.authorization ?? null }) + "\\n");
          if (${responds}) res.end("unrelated listener");
        }).listen(${install.httpPort}, "127.0.0.1", () => console.log("ready"));
      `;
      const listener = spawn(nodeBin(), ["--input-type=module", "-e", script], {
        env: { ...childEnv(install.home, launchctlStub(install.home)), ROOTPATH: foreignDataDir }, stdio: ["ignore", "pipe", "pipe"],
      });
      const exited = once(listener, "exit");
      try {
        await new Promise<void>((resolveReady, reject) => {
          const timer = setTimeout(() => reject(new Error("fixture listener did not start")), 5_000);
          listener.stdout.once("data", () => { clearTimeout(timer); resolveReady(); });
          listener.once("error", err => { clearTimeout(timer); reject(err); });
          listener.once("exit", () => { clearTimeout(timer); reject(new Error("fixture listener exited")); });
        });
        const init = runLocalInit(install, skipStart ? ["--skip-start"] : []);
        expect(init.status, init.stdout + init.stderr).toBe(1);
        expect(init.stderr).toContain(`port ${install.httpPort}`);
        expect(init.stderr).toContain("attribution to this data directory was not confirmed");
        expect(init.stderr).toContain("Remedy:");
        expect(init.stdout).not.toContain("initialized successfully");
        expect(installed(install)).toBe(existing);
        if (existing) expect(readFileSync(configPath, "utf8")).toBe(config);
        expect(existsSync(join(install.home, ".flair", "admin-pass"))).toBe(false);
        expect(existsSync(skillSeedPendingPath(install.dataDir))).toBe(false);
        const requests = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
        expect(requests).toEqual([{ url: "/health", authorization: null }]);
      } finally {
        listener.kill("SIGKILL");
        await exited;
      }
    }, 150_000);
  }

  test("plain init with a fresh HOME and just-released ports succeeds from another cwd", async () => {
    const install = await newInstall();
    const init = runLocalInit(install, ["--agent-id", "userbot"], install.home);
    expect(init.status, init.stdout + init.stderr).toBe(0);
    expect(installed(install)).toBe(true);
    await waitForInstance(install, init.startedAt);
  }, 300_000);

  test("an already-installed instance: --skip-start starts nothing and leaves Harper's config unchanged", async () => {
    const install = await newInstall();

    // Establish the instance the ordinary way: install + start + seed.
    const initial = runLocalInit(install, []);
    expect(initial.status, initial.stdout + initial.stderr).toBe(0);
    await waitForInstance(install, initial.startedAt);
    expect(existsSync(skillSeedPendingPath(install.dataDir)), "a normal init left the seed pending").toBe(false);

    const stop = runLocalService(install, "stop");
    expect(stop.status, stop.stdout + stop.stderr).toBe(0);

    const configBefore = readFileSync(join(install.dataDir, "harper-config.yaml"), "utf8");

    const skipped = runLocalInit(install, ["--skip-start"], ROOT, false);
    expect(skipped.status, skipped.stdout + skipped.stderr).toBe(0);
    // Nothing started ...
    expect(await serves(install.httpPort), "--skip-start started an installed instance").toBe(false);
    // Harper's config contents are unchanged.
    expect(readFileSync(join(install.dataDir, "harper-config.yaml"), "utf8")).toBe(configBefore);
  }, 300_000);
});
