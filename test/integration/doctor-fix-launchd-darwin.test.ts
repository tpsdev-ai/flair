// doctor-fix-launchd-darwin.test.ts — flair#1581 / #1573 slice b3b.
//
// The #1573 acceptance: `flair doctor --fix` must repair launchd management
// END TO END — real launchctl load + a real Harper spawn under launchd —
// and come up managed, non-interactive, without re-bootstrapping a populated
// data dir.
//
// Existing darwin-gated tests (test/unit/*darwin*) MOCK launchctl. This file
// is the other half: it drives the real CLI against real launchd. Logic-only
// coverage of planLaunchdRepair would pass while the reported failure
// (minimal-env → readline prompt → dead launcher) went undetected.
//
// SAFETY — this file talks to real launchd on a host that may be running a
// real Flair:
//
//   - HOME is a throwaway directory, via a genuinely spawned `node dist/cli.js`
//     subprocess. Bun's os.homedir() ignores an in-process HOME mutation;
//     Node honours HOME set before process start. Every plist, data dir and
//     label therefore resolves inside the fixture (instance-scoped label =
//     sha256 of that data dir).
//   - PATH is the real PATH. There is no launchctl shim. Assertions call
//     `launchctl list <label>` and reuse assessLaunchdManagement with that
//     real listing.
//   - The CLI is `node dist/cli.js`, not `bun src/cli.ts`. buildRepairPlist
//     writes process.execPath into the plist; Harper's NAPI modules need
//     Node, and the product launcher `exec`s that binary. A bun execPath
//     would be a different (failing) shape than production.
//   - Teardown unloads the job BEFORE deleting HOME. KeepAlive:true means a
//     leftover loaded job outlives the fixture directory. An exit hook
//     unloads any still-tracked label; it does not signal by pid.
//
// Darwin-gated via test.skipIf(!isDarwin) so Linux CI reports a skip.
// NOT in the #1012 inventory (scripts/check-darwin-gated-tests.mjs skips
// test/integration*): that inventory re-runs every file, including from a
// 60s visibility test, and a real Harper boot does not fit. The macOS
// `test-darwin-gated` job runs this file as its own step.
import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  assessLaunchdManagement,
  parseLaunchctlList,
  pickInstancePid,
} from "../../src/lib/launchd-management.ts";
import {
  buildDirectSpawnEnv,
  harperPortValue,
  launchdLabel,
  launchdPlistPath,
  readHarperConfig,
  resolveHarperBin,
} from "../../src/cli.ts";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle.ts";

const isDarwin = process.platform === "darwin";
const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const CLI_JS = join(REPO_ROOT, "dist", "cli.js");
const MODELS_DIR = join(REPO_ROOT, "models");
const ADMIN_USER = "admin";
const ADMIN_PASS = "test123";
const SEED_IDS = ["b3b-mem-1", "b3b-mem-2", "b3b-mem-3"] as const;
const PROMPT_RE =
  /Please enter a password|readline was closed|ERR_USE_AFTER_CLOSE|Please enter a destination for Harper|\[hidden\]/i;
const TEST_TIMEOUT_MS = 240_000;

/** Jobs this file loaded. Unloaded on afterEach and on process exit. */
const LOADED_JOBS = new Set<{ label: string; plistPath: string }>();

function nodeBin(): string {
  if (process.env.NODE_BIN) return process.env.NODE_BIN;
  if (process.execPath && !process.execPath.includes("bun")) return process.execPath;
  return "node";
}

function requireCliBuild(): void {
  if (!existsSync(CLI_JS)) {
    throw new Error(
      `dist/cli.js is missing — this test drives the real CLI via Node so the regenerated plist execs Node, not bun. Run: bun run build && bun run build:cli`,
    );
  }
}

function launchctlList(label: string): { code: number | null; stdout: string } {
  const res = spawnSync("launchctl", ["list", label], { encoding: "utf-8", timeout: 5_000 });
  return { code: res.status, stdout: res.stdout ?? "" };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPidFile(dataDir: string): number | null {
  const p = join(dataDir, "hdb.pid");
  if (!existsSync(p)) return null;
  const n = Number(readFileSync(p, "utf-8").trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

function listeningPids(port: number): number[] {
  const res = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
    encoding: "utf-8",
    timeout: 5_000,
  });
  if (res.status !== 0) return [];
  return (res.stdout ?? "")
    .trim()
    .split(/\s+/)
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n > 0);
}

function instancePid(dataDir: string, port: number): number | null {
  return pickInstancePid({
    pidFilePid: readPidFile(dataDir),
    isAlive,
    listeningPids: listeningPids(port),
  });
}

/** Product verifier — real launchctl, explicit paths so Bun's homedir() is never consulted. */
function assessManaged(dataDir: string, port: number, launchAgentsDir: string) {
  const label = launchdLabel(dataDir);
  const plistPath = launchdPlistPath(label, launchAgentsDir);
  return assessLaunchdManagement({
    platform: "darwin",
    label,
    plistPath,
    instancePid: instancePid(dataDir, port),
    plistExists: existsSync,
    list: launchctlList,
  });
}

function stripAmbientFlair(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (/^(FLAIR_|HARPER_|HDB_|FABRIC_)/.test(k)) continue;
    out[k] = v;
  }
  return out;
}

function doctorEnv(tmpHome: string): Record<string, string> {
  return {
    ...stripAmbientFlair(process.env),
    HOME: tmpHome,
    FLAIR_MODELS_DIR: MODELS_DIR,
    HDB_ADMIN_PASSWORD: ADMIN_PASS,
    FLAIR_ADMIN_PASS: ADMIN_PASS,
    HDB_ADMIN_USERNAME: ADMIN_USER,
  };
}

async function runDoctorFix(
  tmpHome: string,
  port: number,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  requireCliBuild();
  const proc = spawn(nodeBin(), [CLI_JS, "doctor", "--fix", "--port", String(port)], {
    cwd: REPO_ROOT,
    env: doctorEnv(tmpHome),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  proc.stdout?.on("data", (d: Buffer) => {
    stdout += d.toString();
  });
  proc.stderr?.on("data", (d: Buffer) => {
    stderr += d.toString();
  });
  const exitCode: number = await new Promise((resolveExit, reject) => {
    proc.on("error", reject);
    proc.on("exit", (code) => resolveExit(code ?? 1));
    setTimeout(() => {
      try {
        proc.kill("SIGTERM");
      } catch {
        /* already gone */
      }
      reject(new Error(`flair doctor --fix timed out after 180s\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 180_000);
  });
  return { stdout, stderr, exitCode };
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (res.status > 0) return;
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`no response from ${url} within ${timeoutMs}ms (${last})`);
}

async function waitDead(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`pid ${pid} still alive after ${timeoutMs}ms`);
}

async function adminOp(opsUrl: string, body: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(opsUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + Buffer.from(`${ADMIN_USER}:${ADMIN_PASS}`).toString("base64"),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`ops ${body.operation} → ${res.status}: ${text}`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function seedMemories(opsUrl: string): Promise<void> {
  const now = new Date().toISOString();
  const res = await adminOp(opsUrl, {
    operation: "insert",
    database: "flair",
    table: "Memory",
    records: SEED_IDS.map((id) => ({
      id,
      agentId: "b3b-seed-agent",
      content: `launchd-repair seed ${id}`,
      tags: ["b3b"],
      durability: "permanent",
      visibility: "shared",
      archived: false,
      createdAt: now,
      updatedAt: now,
    })),
  });
  void res;
}

async function survivingIds(opsUrl: string): Promise<string[]> {
  const raw = await adminOp(opsUrl, {
    operation: "search_by_id",
    database: "flair",
    table: "Memory",
    ids: [...SEED_IDS],
    get_attributes: ["id"],
  });
  const rows = Array.isArray(raw) ? raw : [];
  return rows
    .map((r) => (r && typeof r === "object" && "id" in r ? String((r as { id: unknown }).id) : ""))
    .filter((id) => id.length > 0)
    .sort();
}

function configPath(dataDir: string): string {
  const yaml = join(dataDir, "harper-config.yaml");
  const legacy = join(dataDir, "harperdb-config.yaml");
  if (existsSync(yaml)) return yaml;
  if (existsSync(legacy)) return legacy;
  throw new Error(`no harper-config.yaml under ${dataDir}`);
}

function readConfigBytes(dataDir: string): Buffer {
  return readFileSync(configPath(dataDir));
}

function launchdLog(dataDir: string, which: "stderr" | "stdout"): string {
  const p = join(dataDir, "log", `launchd-${which}.log`);
  return existsSync(p) ? readFileSync(p, "utf-8") : "";
}

function clearLaunchdLogs(dataDir: string): void {
  mkdirSync(join(dataDir, "log"), { recursive: true });
  for (const which of ["stderr", "stdout"] as const) {
    writeFileSync(join(dataDir, "log", `launchd-${which}.log`), "");
  }
}

function unloadJob(label: string, plistPath: string): void {
  spawnSync("launchctl", ["unload", plistPath], { encoding: "utf-8", timeout: 10_000 });
  const uid = process.getuid?.();
  if (uid !== undefined) {
    spawnSync("launchctl", ["bootout", `gui/${uid}/${label}`], { encoding: "utf-8", timeout: 10_000 });
  }
}

function trackJob(label: string, plistPath: string): void {
  LOADED_JOBS.add({ label, plistPath });
}

function unloadTracked(): void {
  for (const job of LOADED_JOBS) {
    try {
      unloadJob(job.label, job.plistPath);
    } catch {
      /* best effort */
    }
  }
  LOADED_JOBS.clear();
}

if (isDarwin) {
  process.on("exit", unloadTracked);
}

interface Sandbox {
  tmpHome: string;
  dataDir: string;
  launchAgentsDir: string;
  label: string;
  plistPath: string;
  httpPort: number;
  opsPort: number;
  httpURL: string;
  opsURL: string;
  populate?: HarperInstance;
  direct?: ChildProcess;
}

const live: Sandbox[] = [];

function writeAdminPass(tmpHome: string): void {
  const dir = join(tmpHome, ".flair");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "admin-pass");
  writeFileSync(path, `${ADMIN_PASS}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

async function populateDataDir(sb: Sandbox): Promise<void> {
  mkdirSync(sb.dataDir, { recursive: true });
  mkdirSync(join(sb.dataDir, "log"), { recursive: true });
  writeAdminPass(sb.tmpHome);
  const harper = await startHarper({ installDir: sb.dataDir });
  sb.populate = harper;
  sb.httpPort = Number(new URL(harper.httpURL).port);
  sb.opsPort = Number(new URL(harper.opsURL).port);
  sb.httpURL = harper.httpURL;
  sb.opsURL = harper.opsURL;
  await seedMemories(harper.opsURL);
  const ids = await survivingIds(harper.opsURL);
  if (ids.length !== SEED_IDS.length) {
    throw new Error(`seed wrote ${ids.length} rows, expected ${SEED_IDS.length}: ${ids.join(",")}`);
  }
  await stopHarper(harper, { keepInstallDir: true });
  sb.populate = undefined;
  if (!existsSync(configPath(sb.dataDir))) {
    throw new Error("harper-config.yaml missing after populate — cannot exercise config-authority repair");
  }
}

async function doctorFixToManaged(sb: Sandbox): Promise<{ stdout: string; stderr: string }> {
  const result = await runDoctorFix(sb.tmpHome, sb.httpPort);
  trackJob(sb.label, sb.plistPath);
  await waitForHttp(sb.httpURL, 60_000);
  const after = assessManaged(sb.dataDir, sb.httpPort, sb.launchAgentsDir);
  if (after.state !== "managed") {
    throw new Error(
      `doctor --fix did not leave the instance managed: ${after.state} — ${after.detail}\n` +
        `stdout:\n${result.stdout}\nstderr:\n${result.stderr}\n` +
        `launchd-stderr:\n${launchdLog(sb.dataDir, "stderr")}`,
    );
  }
  return result;
}

async function newSandbox(): Promise<Sandbox> {
  const tmpHome = mkdtempSync(join(tmpdir(), "flair1581-home-"));
  const dataDir = resolve(join(tmpHome, ".flair", "data"));
  const launchAgentsDir = join(tmpHome, "Library", "LaunchAgents");
  mkdirSync(launchAgentsDir, { recursive: true });
  const label = launchdLabel(dataDir);
  const plistPath = launchdPlistPath(label, launchAgentsDir);
  const sb: Sandbox = {
    tmpHome,
    dataDir,
    launchAgentsDir,
    label,
    plistPath,
    httpPort: 0,
    opsPort: 0,
    httpURL: "",
    opsURL: "",
  };
  live.push(sb);
  await populateDataDir(sb);
  // First repair (missing plist → regenerate → managed) settles HARPER_SET_CONFIG
  // so the scenario under test can assert harper-config.yaml is byte-identical.
  await doctorFixToManaged(sb);
  const cfg = readHarperConfig(sb.dataDir);
  const httpPort = harperPortValue(cfg?.http?.port) ?? sb.httpPort;
  const opsPort = harperPortValue(cfg?.operationsApi?.network?.port) ?? sb.opsPort;
  sb.httpPort = httpPort;
  sb.opsPort = opsPort;
  sb.httpURL = `http://127.0.0.1:${httpPort}`;
  sb.opsURL = `http://127.0.0.1:${opsPort}`;
  return sb;
}

function refreshPortsFromConfig(sb: Sandbox): void {
  const cfg = readHarperConfig(sb.dataDir);
  const httpPort = harperPortValue(cfg?.http?.port);
  const opsPort = harperPortValue(cfg?.operationsApi?.network?.port);
  if (httpPort) {
    sb.httpPort = httpPort;
    sb.httpURL = `http://127.0.0.1:${httpPort}`;
  }
  if (opsPort) {
    sb.opsPort = opsPort;
    sb.opsURL = `http://127.0.0.1:${opsPort}`;
  }
}

async function teardown(sb: Sandbox): Promise<void> {
  unloadJob(sb.label, sb.plistPath);
  LOADED_JOBS.forEach((j) => {
    if (j.label === sb.label) LOADED_JOBS.delete(j);
  });
  if (sb.direct && sb.direct.pid && isAlive(sb.direct.pid)) {
    try {
      process.kill(sb.direct.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
    try {
      await waitDead(sb.direct.pid, 8_000);
    } catch {
      try {
        process.kill(sb.direct.pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
  }
  if (sb.populate) {
    try {
      await stopHarper(sb.populate, { keepInstallDir: true });
    } catch {
      /* best effort */
    }
  }
  const pid = readPidFile(sb.dataDir);
  if (pid && isAlive(pid)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* gone */
    }
    try {
      await waitDead(pid, 8_000);
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
  }
  rmSync(sb.tmpHome, { recursive: true, force: true });
}

afterEach(async () => {
  while (live.length) {
    const sb = live.pop();
    if (sb) await teardown(sb);
  }
});

function assertNoPrompt(log: string, cliOut: string): void {
  expect(log, `StandardErrorPath contained a readline/prompt:\n${log}`).not.toMatch(PROMPT_RE);
  expect(cliOut, `doctor --fix itself prompted:\n${cliOut}`).not.toMatch(PROMPT_RE);
}

function assertSecretFreePlist(plistPath: string): void {
  const raw = readFileSync(plistPath, "utf-8");
  expect(raw.includes("HDB_ADMIN_PASSWORD"), "regenerated plist must not embed the admin password").toBe(false);
  expect(raw).toContain("<plist");
  expect(raw).toContain("<dict>");
}

function assertManaged(sb: Sandbox): { pid: number; detail: string } {
  const listed = launchctlList(sb.label);
  expect(listed.code, `launchctl list ${sb.label} failed:\n${listed.stdout}`).toBe(0);
  const parsed = parseLaunchctlList(listed.stdout);
  expect(parsed.pid, `launchctl list ${sb.label} has no PID:\n${listed.stdout}`).not.toBeNull();
  const serving = instancePid(sb.dataDir, sb.httpPort);
  expect(serving, "could not resolve the serving PID").not.toBeNull();
  expect(serving, "launchd PID is not the serving process").toBe(parsed.pid);
  const observation = assessManaged(sb.dataDir, sb.httpPort, sb.launchAgentsDir);
  expect(observation.state, observation.detail).toBe("managed");
  expect(observation.label).toBe(sb.label);
  return { pid: parsed.pid!, detail: observation.detail };
}

async function snapshotBeforeFix(sb: Sandbox): Promise<{ config: Buffer; ids: string[] }> {
  refreshPortsFromConfig(sb);
  await waitForHttp(sb.httpURL, 30_000);
  const ids = await survivingIds(sb.opsURL);
  expect(ids).toEqual([...SEED_IDS]);
  return { config: readConfigBytes(sb.dataDir), ids };
}

async function assertNoRebootstrap(sb: Sandbox, before: { config: Buffer; ids: string[] }): Promise<void> {
  const afterConfig = readConfigBytes(sb.dataDir);
  expect(afterConfig.equals(before.config), "harper-config.yaml must be byte-identical across doctor --fix (no re-bootstrap)").toBe(true);
  await waitForHttp(sb.opsURL, 30_000);
  const afterIds = await survivingIds(sb.opsURL);
  expect(afterIds, "memory rows must survive doctor --fix").toEqual(before.ids);
  expect(afterIds.length).toBe(SEED_IDS.length);
}

async function stopManagedHarper(sb: Sandbox): Promise<void> {
  const pid = instancePid(sb.dataDir, sb.httpPort);
  unloadJob(sb.label, sb.plistPath);
  if (pid) {
    try {
      await waitDead(pid, 20_000);
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* gone */
      }
      await waitDead(pid, 8_000).catch(() => {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* gone */
        }
      });
    }
  }
}

function writeCorruptPlist(sb: Sandbox): void {
  mkdirSync(sb.launchAgentsDir, { recursive: true });
  // The reported rockit corruption: a bare JSON array instead of an XML dict.
  writeFileSync(sb.plistPath, `["${join(REPO_ROOT, "templates", "launchd", "start-flair-with-admin-pass.sh")}"]\n`);
}

async function directSpawnDetached(sb: Sandbox): Promise<number> {
  const harper = resolveHarperBin([REPO_ROOT]);
  if (!harper.path) throw new Error(`Harper binary not found. Searched:\n${harper.searched.join("\n")}`);
  const env: Record<string, string> = {
    ...stripAmbientFlair(process.env),
    ...buildDirectSpawnEnv({
      dataDir: sb.dataDir,
      modelsDir: MODELS_DIR,
      httpPort: sb.httpPort,
      opsPort: sb.opsPort,
      opsBindHost: "127.0.0.1",
      adminUser: ADMIN_USER,
      adminPass: ADMIN_PASS,
    }),
    HOME: sb.tmpHome,
    PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
  };
  const proc = spawn(nodeBin(), [harper.path, "run", "."], {
    cwd: REPO_ROOT,
    env,
    detached: true,
    stdio: "ignore",
  });
  proc.unref();
  sb.direct = proc;
  if (!proc.pid) throw new Error("direct spawn produced no pid");
  await waitForHttp(sb.httpURL, 60_000);
  const serving = instancePid(sb.dataDir, sb.httpPort);
  if (serving === null) throw new Error("direct-spawned Harper is up but the serving PID is unreadable");
  return serving;
}

test.skipIf(!isDarwin)(
  "corrupt or missing launchd plist: doctor --fix regenerates and comes up managed",
  async () => {
    requireCliBuild();
    const sb = await newSandbox();
    const before = await snapshotBeforeFix(sb);
    await stopManagedHarper(sb);
    writeCorruptPlist(sb);
    clearLaunchdLogs(sb.dataDir);

    const result = await doctorFixToManaged(sb);
    const managed = assertManaged(sb);
    assertSecretFreePlist(sb.plistPath);
    const errLog = launchdLog(sb.dataDir, "stderr");
    assertNoPrompt(errLog, `${result.stdout}\n${result.stderr}`);
    // assertManaged already proves managed+serving (launchctl PID == serving
    // PID + health). Do not require a Harper stderr banner — "listening on"
    // was MQTT-tied and disappears once mqtt is fully off (flair#1586).
    await assertNoRebootstrap(sb, before);
    expect(result.stdout + result.stderr).toMatch(/launchd|regenerat|managed/i);
    expect(managed.pid).toBeGreaterThan(0);
  },
  TEST_TIMEOUT_MS,
);

test.skipIf(!isDarwin)(
  "detached direct-spawned instance: doctor --fix adopts into launchd, bouncing once",
  async () => {
    requireCliBuild();
    const sb = await newSandbox();
    const before = await snapshotBeforeFix(sb);
    const managedPid = instancePid(sb.dataDir, sb.httpPort);
    await stopManagedHarper(sb);
    // Keep a valid-ours plist on disk but unloaded — registered-but-not-loaded
    // plus a live direct-spawn is the adopt shape (flair#1573 slice b2).
    const detachedPid = await directSpawnDetached(sb);
    expect(detachedPid, "direct-spawned PID should differ from the previous launchd PID").not.toBe(managedPid);
    const pre = assessManaged(sb.dataDir, sb.httpPort, sb.launchAgentsDir);
    expect(pre.state, `pre-adopt state should not be managed: ${pre.detail}`).not.toBe("managed");
    // Direct-spawn re-asserts MQTT_* via buildDirectSpawnEnv (flair#1586).
    // Harper persists those into harper-config.yaml. Snapshot AFTER that
    // write so assertNoRebootstrap measures doctor --fix, not the detach.
    const beforeAdopt = { config: readConfigBytes(sb.dataDir), ids: before.ids };
    clearLaunchdLogs(sb.dataDir);

    const result = await doctorFixToManaged(sb);
    const managed = assertManaged(sb);
    expect(isAlive(detachedPid), `adopt must clean-stop the direct-spawned pid ${detachedPid}`).toBe(false);
    expect(managed.pid, "adopt must bounce the live instance exactly once (new launchd PID)").not.toBe(detachedPid);
    expect(isAlive(managed.pid)).toBe(true);
    const errLog = launchdLog(sb.dataDir, "stderr");
    assertNoPrompt(errLog, `${result.stdout}\n${result.stderr}`);
    // assertManaged already proves managed+serving. Bounce-once is the PID
    // change + the 2s stability check below — not a component-tied stderr
    // banner. "listening on" disappeared once mqtt was fully off (flair#1586).
    assertSecretFreePlist(sb.plistPath);
    await assertNoRebootstrap(sb, beforeAdopt);
    expect(result.stdout + result.stderr).toMatch(/adopt|bounc/i);
    await new Promise((r) => setTimeout(r, 2_000));
    expect(instancePid(sb.dataDir, sb.httpPort), "PID must stay stable after adopt (no KeepAlive restart loop)").toBe(
      managed.pid,
    );
  },
  TEST_TIMEOUT_MS,
);
