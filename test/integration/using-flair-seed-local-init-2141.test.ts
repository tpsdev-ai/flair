// ─── flair#2141 S2 — local normal-init and installed-instance handoff ────────
//
// The built CLI runs three local installations (no --target), each in a temp
// data dir under a scratch HOME. The first two are fresh normal inits, one with
// an agent and one without; each installs and starts Harper, then asserts the
// skill row, org assignment, and a new agent's bootstrap entry. The third first
// installs normally, deletes both seed rows, stops Harper, and re-initializes
// that already-installed default instance with --skip-start. It then checks one
// start without the credential and another with FLAIR_ADMIN_PASS.
//
// Isolation:
//   - HOME is a fresh temp dir, so the data dir, admin-pass, keys and any plist
//     land there;
//   - ports are free ephemeral ports, asserted not to be 9925/9926;
//   - PATH starts with a `launchctl` stub that answers "no such service", so on
//     macOS init's read-only launchd checks never reach the real launchd domain
//     (a fresh init writes a plist into HOME and does not load it);
//   - teardown kills only the pid in this data dir's hdb.pid when lsof finds
//     no listener or identifies that pid on this test's port;
//   - the CLI runs under Node, so the Harper it starts runs under Node too.
//
// Readiness (flair#2240): wait for health and ops before the test's subsequent
// direct ops calls; credential-less pending starts do not guarantee ops readiness.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import nacl from "tweetnacl";
import { ensureCliBuild } from "../helpers/build-cli-once.js";
import { SEED_ASSIGNMENT_ID, SEED_SKILL_ID } from "../../src/lib/skill-seed.js";
import { skillSeedPendingPath } from "../../src/lib/skill-seed-pending.js";
import { USING_FLAIR_SKILL_CONTENT } from "../../src/lib/using-flair-skill.js";

const ROOT = resolve(import.meta.dirname, "..", "..");
const CLI = join(ROOT, "dist", "cli.js");
const ADMIN_USER = "admin";
const ADMIN_PASS = `seed-local-${randomUUID()}`;

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
  // The model the CI lanes pre-fetch; else <repo>/models (the harper-lifecycle default).
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
  const home = mkdtempSync(join(tmpdir(), "fli-"));
  const [httpPort, opsPort] = await freePorts();
  const install: Install = { home, dataDir: join(home, ".flair", "data"), httpPort, opsPort };
  expect(httpPort).not.toBe(opsPort);
  for (const port of [httpPort, opsPort]) expect(["9925", "9926"]).not.toContain(String(port));
  installs.push(install);
  return install;
}

/**
 * The CLI runs under Node, as an installed `flair` does: a local init spawns
 * Harper with its own `process.execPath`, and Harper's native modules need Node
 * (the same rule as doctor-fix-launchd-darwin.test.ts's nodeBin).
 */
function nodeBin(): string {
  if (process.env.NODE_BIN) return process.env.NODE_BIN;
  if (process.execPath && !process.execPath.includes("bun")) return process.execPath;
  return "node";
}

function runLocalInit(install: Install, extraArgs: string[], supplyCredential = true) {
  const startedAt = Date.now();
  const res = spawnSync(
    nodeBin(),
    [CLI, "init", "--port", String(install.httpPort), "--ops-port", String(install.opsPort), ...(supplyCredential ? ["--admin-pass", ADMIN_PASS] : []),
      "--skip-soul", "--no-mcp", "--skip-smoke", "--skip-claude-md", "--skip-hook", ...extraArgs],
    {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 60_000,
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
    timeout: 60_000,
    killSignal: "SIGKILL",
    env: { ...childEnv(install.home, launchctlStub(install.home)), ...extraEnv },
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "", startedAt };
}

/**
 * Wait until this test's instance is actually serving: its HTTP `/Health`
 * endpoint answers 2xx or 401 AND its operations API answers a real request.
 *
 * `startedAt` is the CLI launch time included in the timeout's measured startup.
 */
async function waitForInstance(install: Install, startedAt: number): Promise<number> {
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
      // 2xx = healthy; 401 = Harper up, credentials wrong — still serving.
      if (health.ok || health.status === 401) {
        const res = await fetch(opsURL, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: basic() },
          body: JSON.stringify({ operation: "search_by_id", database: "flair", table: "Memory", ids: ["__readiness_probe__"], get_attributes: ["id"] }),
          signal: AbortSignal.timeout(5_000),
        });
        if (res.status === 200) {
          const elapsed = Date.now() - startedAt;
          console.log(`[2141-local-init] instance ready (health + ops answered) after ${elapsed}ms`);
          return elapsed;
        }
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

/** The skill row and the org assignment, read through the ops API. */
async function seedRows(install: Install): Promise<{ row: any; assignments: any[] }> {
  const rows = await ops(install, {
    operation: "search_by_id", database: "flair", table: "Memory", ids: [SEED_SKILL_ID],
    get_attributes: ["id", "agentId", "content", "tags", "visibility", "archived"],
  });
  const assignments = await ops(install, {
    operation: "search_by_id", database: "flair", table: "OrgSkillAssignment", ids: [SEED_ASSIGNMENT_ID],
    get_attributes: ["id", "skillName", "skillRef", "priority", "writer", "sourceClass"],
  });
  return { row: Array.isArray(rows) ? rows[0] ?? null : null, assignments: Array.isArray(assignments) ? assignments : [] };
}

/** Register a new agent and return its bootstrap's org skills. */
async function newAgentSkills(install: Install): Promise<any[]> {
  const kp = nacl.sign.keyPair();
  const id = `fli-agent-${Date.now().toString(36)}`;
  await ops(install, {
    operation: "upsert", database: "flair", table: "Agent",
    records: [{ id, name: id, kind: "agent", status: "active", role: "agent", publicKey: Buffer.from(kp.publicKey).toString("base64"), createdAt: new Date().toISOString() }],
  });
  const path = "/BootstrapMemories";
  const ts = String(Date.now());
  const nonce = randomUUID();
  const sig = nacl.sign.detached(new TextEncoder().encode(`${id}:${ts}:${nonce}:POST:${path}`), kp.secretKey);
  const res = await fetch(`http://127.0.0.1:${install.httpPort}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `TPS-Ed25519 ${id}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}` },
    body: JSON.stringify({ agentId: id, maxTokens: 4000 }),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  expect(res.status, `bootstrap: ${text.slice(0, 300)}`).toBe(200);
  return JSON.parse(text).skills ?? [];
}

async function expectSeeded(install: Install): Promise<void> {
  const { row, assignments } = await seedRows(install);
  expect(row, "the using-flair Memory row exists").toBeTruthy();
  expect(row).toMatchObject({ id: SEED_SKILL_ID, agentId: ADMIN_USER, content: USING_FLAIR_SKILL_CONTENT, visibility: "shared" });
  expect(row.tags).toContain("skill");
  expect(row.archived ?? false).toBe(false);
  expect(assignments).toEqual([{
    id: SEED_ASSIGNMENT_ID, skillName: "using-flair", skillRef: SEED_SKILL_ID, priority: "standard",
    writer: ADMIN_USER, sourceClass: "operator",
  }]);
  const skills = await newAgentSkills(install);
  expect(skills.find((s: any) => s.name === "using-flair"), JSON.stringify(skills)).toEqual({
    name: "using-flair", skillId: SEED_SKILL_ID, scope: "org", priority: "standard", source: null,
  });
}

function listeningPids(port: number): number[] {
  const res = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8", timeout: 5_000 });
  return (res.stdout ?? "").split("\n").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function stopInstall(install: Install): Promise<void> {
  const pidFile = join(install.dataDir, "hdb.pid");
  const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8").trim()) : NaN;
  const listening = listeningPids(install.httpPort);
  // Only this data dir's Harper: its own pid file, and (when lsof answers) the
  // process listening on this test's port.
  if (Number.isInteger(pid) && pid > 0 && (listening.length === 0 || listening.includes(pid))) {
    try { process.kill(pid, "SIGTERM"); } catch { /* gone */ }
    const deadline = Date.now() + 15_000;
    while (alive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    if (alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  }
  rmSync(install.home, { recursive: true, force: true });
}

// Case budgets (seconds): CLI + readiness + probe overrun + requests + teardown + margin.
// fresh: 60 + 30 + 7.25 + 45 + 60 + 30 = 232.25.
// handoff stages: 2*60 + 30 + 7.25 + 20 + 60 + 30 = 267.25.
// seeded restart: 2*60 + 30 + 7.25 + 45 + 60 + 30 = 292.25.

describe("flair#2141 S2 — local init and installed-instance handoff", () => {
  beforeAll(() => ensureCliBuild(), 210_000);

  describe("fresh init", () => {
    afterEach(async () => {
      while (installs.length > 0) await stopInstall(installs.pop() as Install);
    }, TEARDOWN_TIMEOUT_MS);

    test("with an agent registered (init's agent path)", async () => {
      const install = await newInstall();
      const run = runLocalInit(install, ["--agent-id", `fli-init-${Date.now().toString(36)}`]);
      expect(run.status, `init failed (signal ${run.signal}):\n${run.stdout.slice(-1500)}\n${run.stderr.slice(-1500)}`).toBe(0);
      expect(run.stdout).toContain("using-flair skill: seeded the using-flair skill");
      await waitForInstance(install, run.startedAt);
      await expectSeeded(install);
    }, 232_250);

    test("with no agent registered (init's no-agent path)", async () => {
      const install = await newInstall();
      const run = runLocalInit(install, []);
      expect(run.status, `init failed (signal ${run.signal}):\n${run.stdout.slice(-1500)}\n${run.stderr.slice(-1500)}`).toBe(0);
      expect(run.stdout).toContain("using-flair skill: seeded the using-flair skill");
      await waitForInstance(install, run.startedAt);
      await expectSeeded(install);
    }, 232_250);
  });

  describe("installed-instance handoff", () => {
    let install: Install;
    afterAll(async () => {
      while (installs.length > 0) await stopInstall(installs.pop() as Install);
    }, TEARDOWN_TIMEOUT_MS);

    test("install, clear the seed and stop the default instance", async () => {
      install = await newInstall();
      const initial = runLocalInit(install, []);
      expect(initial.status, initial.stdout + initial.stderr).toBe(0);
      await waitForInstance(install, initial.startedAt);
      await ops(install, { operation: "delete", database: "flair", table: "Memory", ids: [SEED_SKILL_ID] });
      await ops(install, { operation: "delete", database: "flair", table: "OrgSkillAssignment", ids: [SEED_ASSIGNMENT_ID] });
      const firstStop = runLocalService(install, "stop");
      expect(firstStop.status, firstStop.stdout + firstStop.stderr).toBe(0);
    }, 267_250);

    test("--skip-start stays pending through a credential-less start", async () => {
      const skipped = runLocalInit(install, ["--skip-start"], false);
      expect(skipped.status, skipped.stdout + skipped.stderr).toBe(0);
      expect(skipped.stdout).toContain("using-flair skill: pending");
      expect(existsSync(skillSeedPendingPath(install.dataDir))).toBe(true);
      const adminPassPath = join(install.home, ".flair", "admin-pass");
      // Remove the operator credential regardless of the persisted-admin detector (#2210).
      rmSync(adminPassPath, { force: true });

      const withoutCredential = runLocalService(install, "start");
      expect(withoutCredential.status, withoutCredential.stdout + withoutCredential.stderr).toBe(0);
      expect(withoutCredential.stderr).toContain("using-flair skill seed is still pending");
      expect(withoutCredential.stderr).toContain("FLAIR_ADMIN_PASS");
      expect(existsSync(skillSeedPendingPath(install.dataDir))).toBe(true);
      await waitForInstance(install, withoutCredential.startedAt);
      expect((await seedRows(install)).row).toBeNull();
    }, 267_250);

    test("a credentialed restart completes the pending seed", async () => {
      const secondStop = runLocalService(install, "stop");
      expect(secondStop.status, secondStop.stdout + secondStop.stderr).toBe(0);
      const withCredential = runLocalService(install, "start", { FLAIR_ADMIN_PASS: ADMIN_PASS });
      expect(withCredential.status, withCredential.stdout + withCredential.stderr).toBe(0);
      expect(withCredential.stdout).toContain("using-flair skill: seeded the using-flair skill");
      expect(existsSync(skillSeedPendingPath(install.dataDir))).toBe(false);
      await waitForInstance(install, withCredential.startedAt);
      await expectSeeded(install);
    }, 292_250);
  });
});
