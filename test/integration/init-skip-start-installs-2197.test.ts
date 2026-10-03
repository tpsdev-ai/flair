// ─── flair#2197 — `init --skip-start` installs and configures without starting ─
//
// `--skip-start` used to skip Harper installation as well as the start, so on an
// empty data directory nothing existed for a later `flair start` and anything
// deferred to first start (the #2165 pending using-flair seed) never happened.
// It now installs and configures without starting: on an empty data directory
// the installation exists, nothing is running, and on the default instance the
// first-start work is queued for the next `flair start`, which starts the
// instance and performs it. On an already-installed instance it starts nothing
// and leaves the installation unchanged.
//
// The built CLI runs under Node (Harper's native modules need it). Isolation:
//   - HOME is a fresh temp dir, so the default data dir, admin-pass, keys and
//     any plist land there;
//   - ports are free ephemeral ports, asserted not to be 9925/9926;
//   - PATH starts with a `launchctl` stub, so on macOS init's read-only launchd
//     checks never reach the real launchd domain;
//   - teardown signals only the pid in this data dir's hdb.pid; the temp HOME is
//     removed.
//
// Each case fails on main where applicable:
//   - (a) fails on main at "the installation exists" (init --skip-start installed
//     nothing);
//   - (b) is a no-regression guard: --skip-start must not start or reconfigure an
//     already-installed instance.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
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
  const home = mkdtempSync(join(tmpdir(), "fss-"));
  const [httpPort, opsPort] = await freePorts();
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

function runLocalInit(install: Install, extraArgs: string[]) {
  const startedAt = Date.now();
  const res = spawnSync(
    nodeBin(),
    [CLI, "init", "--port", String(install.httpPort), "--ops-port", String(install.opsPort), "--admin-pass", ADMIN_PASS,
      "--skip-soul", "--no-mcp", "--skip-smoke", "--skip-claude-md", "--skip-hook", ...extraArgs],
    {
      cwd: ROOT,
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

describe("flair#2197 — init --skip-start installs and configures without starting", () => {
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

    const skipped = runLocalInit(install, ["--skip-start"]);
    expect(skipped.status, skipped.stdout + skipped.stderr).toBe(0);
    // Nothing started ...
    expect(await serves(install.httpPort), "--skip-start started an installed instance").toBe(false);
    // ... and the installation was not reconfigured.
    expect(readFileSync(join(install.dataDir, "harper-config.yaml"), "utf8")).toBe(configBefore);
  }, 300_000);
});
