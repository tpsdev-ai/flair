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
//     attempts to unload still-tracked labels; it does not signal by pid.
//
// Skipped outside Darwin and when HARPER_HTTP_URL is set.
// NOT in the #1012 inventory (scripts/check-darwin-gated-tests.mjs skips
// test/integration*): that inventory re-runs every file, including from a
// 60s visibility test, and a real Harper boot does not fit. The macOS
// `test-darwin-gated` job runs this file as its own step.
import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import type { Dirent, Stats } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  assessLaunchdManagement,
  parseLaunchctlList,
  pickInstancePid,
} from "../../src/lib/launchd-management.ts";
import { readProcessStartSecondMs, readProcessStartTimeMs } from "../../src/lib/process-start-time.ts";
import { verifyIdentity } from "../../src/lib/daemon-liveness.ts";
import {
  buildDirectSpawnEnv,
  harperPortValue,
  launchdLabel,
  launchdPlistPath,
  readHarperConfig,
  readSidecar,
  resolveHarperBin,
} from "../../src/cli.ts";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle.ts";
import { childOverranDeadline, cliLeg } from "../helpers/child-deadline.ts";
import { cleanupLaunchdSandbox, unloadJob, type TrackedLaunchdJob } from "../helpers/launchd-job-cleanup.ts";

const isDarwin = process.platform === "darwin";
const externalHarper = process.env.HARPER_HTTP_URL !== undefined;
// Every fixture case gates on this one predicate. The "inherited external Harper
// URL" case re-runs this file with HARPER_HTTP_URL set and requires 0 pass, so a
// case gated on isDarwin alone fails it.
const skipFixtureCase = !isDarwin || externalHarper;
if (externalHarper) console.log("doctor-fix-launchd-darwin: skipped; HARPER_HTTP_URL is set; requires locally spawned Harper");
const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const CLI_JS = join(REPO_ROOT, "dist", "cli.js");
const MODELS_DIR = join(REPO_ROOT, "models");
const ADMIN_USER = "admin";
const ADMIN_PASS = "test123";
const SEED_IDS = ["b3b-mem-1", "b3b-mem-2", "b3b-mem-3"] as const;
const PROMPT_RE =
  /Please enter a password|readline was closed|ERR_USE_AFTER_CLOSE|Please enter a destination for Harper|\[hidden\]/i;
const CHILD_DEADLINE_MS = 90_000;
const CORRUPT_PLIST_CASE_BUDGET_MS = 750_000;
const ADOPT_DETACHED_CASE_BUDGET_MS = 850_000;
const ADOPT_NO_PASS_CASE_BUDGET_MS = 830_000;
const REFUSE_NO_PASS_CASE_BUDGET_MS = 540_000;
const INIT_UNCHANGED_CASE_BUDGET_MS = 510_000;

const LOADED_JOBS = new Set<TrackedLaunchdJob>();

/** The last CLI run (doctor --fix / init) — printed by dumpDiagnostics when a case fails. */
interface CliRun {
  what: string;
  exitCode: number | null;
  signal: string | null;
  elapsedMs: number;
  stdout: string;
  stderr: string;
}
let lastCliRun: CliRun | undefined;

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
  const res = spawnSync("launchctl", ["list", label], { encoding: "utf-8", timeout: 5_000, killSignal: "SIGKILL" });
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

function doctorEnv(tmpHome: string, opts: { adminPassEnv?: boolean } = {}): Record<string, string> {
  const env: Record<string, string> = {
    ...stripAmbientFlair(process.env),
    HOME: tmpHome,
    FLAIR_MODELS_DIR: MODELS_DIR,
  };
  // The adopt-with-no-pass-file case (#1685) needs the env credential present;
  // the refusal case needs it absent, so the file cannot be created.
  if (opts.adminPassEnv !== false) {
    env.HDB_ADMIN_PASSWORD = ADMIN_PASS;
    env.FLAIR_ADMIN_PASS = ADMIN_PASS;
  }
  env.HDB_ADMIN_USERNAME = ADMIN_USER;
  return env;
}

async function runDoctorFix(
  tmpHome: string,
  port: number,
  opts: { adminPassEnv?: boolean } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  requireCliBuild();
  const proc = spawn(nodeBin(), [CLI_JS, "doctor", "--fix", "--port", String(port)], {
    cwd: REPO_ROOT,
    env: doctorEnv(tmpHome, opts),
    stdio: ["ignore", "pipe", "pipe"],
    timeout: CHILD_DEADLINE_MS,
  });
  let stdout = "";
  let stderr = "";
  proc.stdout?.on("data", (d: Buffer) => {
    stdout += d.toString();
  });
  proc.stderr?.on("data", (d: Buffer) => {
    stderr += d.toString();
  });
  const startedAt = Date.now();
  const exitCode: number = await new Promise((resolveExit, reject) => {
    proc.on("error", reject);
    proc.on("exit", (code, signal) => {
      lastCliRun = { what: "doctor --fix", exitCode: code, signal, elapsedMs: Date.now() - startedAt, stdout, stderr };
      if (signal !== null) {
        reject(new Error(childOverranDeadline("flair CLI", cliLeg(["doctor", "--fix"]), CHILD_DEADLINE_MS, { status: code, signal, stdout, stderr, elapsedMs: Date.now() - startedAt, timeoutSignal: "SIGTERM" })));
        return;
      }
      resolveExit(code ?? 1);
    });
  });
  return { stdout, stderr, exitCode };
}

async function runInit(
  tmpHome: string,
  port: number,
  extraArgs: string[] = [],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  requireCliBuild();
  const proc = spawn(
    nodeBin(),
    [CLI_JS, "init", "--port", String(port), "--no-mcp", "--skip-soul", ...extraArgs],
    {
      cwd: REPO_ROOT,
      // No env credential: the sandbox's ~/.flair/admin-pass is the source, so
      // this exercises the reuse leg of the resolution rather than a proof.
      env: doctorEnv(tmpHome, { adminPassEnv: false }),
      stdio: ["ignore", "pipe", "pipe"],
      timeout: CHILD_DEADLINE_MS,
    },
  );
  let stdout = "";
  let stderr = "";
  proc.stdout?.on("data", (d: Buffer) => {
    stdout += d.toString();
  });
  proc.stderr?.on("data", (d: Buffer) => {
    stderr += d.toString();
  });
  const startedAt = Date.now();
  const exitCode: number = await new Promise((resolveExit, reject) => {
    proc.on("error", reject);
    proc.on("exit", (code, signal) => {
      lastCliRun = { what: "init", exitCode: code, signal, elapsedMs: Date.now() - startedAt, stdout, stderr };
      if (signal !== null) {
        reject(new Error(childOverranDeadline("flair CLI", cliLeg(["init"]), CHILD_DEADLINE_MS, { status: code, signal, stdout, stderr, elapsedMs: Date.now() - startedAt, timeoutSignal: "SIGTERM" })));
        return;
      }
      resolveExit(code ?? 1);
    });
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

// Returns the socket's stat once it exists, so a caller reads its mode from this one stat.
async function waitForSocket(path: string, timeoutMs: number): Promise<Stats> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const st = statSync(path);
      if (st.isSocket()) return st;
    } catch {
      // not there yet
    }
    if (Date.now() >= deadline) throw new Error(`${path} did not appear as a socket within ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 50));
  }
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

// ─── flair#2040 CI diagnostics ───────────────────────────────────────────────
// This file runs only on the macOS CI runner, so when a case fails there the
// log is all there is. Print — bounded, with the fixture password redacted —
// what the CLI said, what launchd holds for the fixture's label, the plist, the
// instance's logs and its processes. Read-only; the fixture label only.
const DIAG_MAX_CHARS = 4_000;
const DIAG_MAX_LOG_FILES = 8;

function redactDiag(text: string): string {
  // The fixture password is a test value, but it never belongs in a CI log.
  return text.split(ADMIN_PASS).join("<redacted>");
}

function boundDiag(text: string): string {
  const t = redactDiag(text);
  return t.length > DIAG_MAX_CHARS ? `[... ${t.length - DIAG_MAX_CHARS} earlier chars omitted ...]\n${t.slice(-DIAG_MAX_CHARS)}` : t;
}

function runDiag(cmd: string, args: string[]): string {
  const res = spawnSync(cmd, args, { encoding: "utf-8", timeout: 5_000, killSignal: "SIGKILL" });
  const how = res.error ? `error: ${res.error.message}` : res.signal ? `signal ${res.signal}` : `exit ${res.status}`;
  return `$ ${cmd} ${args.join(" ")} -> ${how}\n${res.stdout ?? ""}${res.stderr ? `[stderr]\n${res.stderr}` : ""}`;
}

/** Plist text with any value under a credential-looking key replaced (paths stay). */
function redactPlistText(raw: string): string {
  return raw.replace(/(<key>[^<]*(?:PASS|SECRET|TOKEN|CREDENTIAL)[^<]*<\/key>\s*<string>)[^<]*(<\/string>)/gi, "$1<redacted>$2");
}

function logFilesUnder(dir: string, depth: number): string[] {
  const found: string[] = [];
  let entries: Dirent[] = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory() && depth > 0) found.push(...logFilesUnder(p, depth - 1));
    else if (e.isFile() && e.name.endsWith(".log")) found.push(p);
  }
  return found;
}

function dumpDiagnostics(sb: Sandbox, why: string): void {
  const out: string[] = [];
  const section = (title: string, body: string): void => {
    out.push(`----- ${title} -----\n${boundDiag(body)}`);
  };
  out.push(`===== flair#2040 diagnostics: ${redactDiag(why).slice(0, 600)} =====`);
  out.push(`label=${sb.label} plist=${sb.plistPath} dataDir=${sb.dataDir} http=${sb.httpPort} ops=${sb.opsPort}`);
  if (lastCliRun) {
    const r = lastCliRun;
    out.push(`last CLI run: flair ${r.what} -> exit ${r.exitCode}${r.signal ? ` signal ${r.signal}` : ""} after ${r.elapsedMs}ms`);
    section(`flair ${r.what} stdout`, r.stdout);
    section(`flair ${r.what} stderr`, r.stderr);
  } else {
    out.push("last CLI run: none recorded");
  }
  const uid = process.getuid?.();
  if (uid !== undefined) {
    section(`launchctl print gui/${uid}/${sb.label}`, runDiag("launchctl", ["print", `gui/${uid}/${sb.label}`]));
    // The preflight's two domain reads: the domain probe's exit code, and the
    // head of print-disabled (its "disabled services" block is what it parses).
    const domain = spawnSync("launchctl", ["print", `gui/${uid}`], { encoding: "utf-8", timeout: 5_000, killSignal: "SIGKILL" });
    out.push(`launchctl print gui/${uid} -> exit ${domain.status}${domain.signal ? ` signal ${domain.signal}` : ""}`);
    section(`launchctl print-disabled gui/${uid} (head)`, runDiag("launchctl", ["print-disabled", `gui/${uid}`]).slice(0, 1_500));
  }
  const listed = launchctlList(sb.label);
  section(`launchctl list ${sb.label} (exit ${listed.code})`, listed.stdout);
  let plistText = "(absent)";
  try {
    if (existsSync(sb.plistPath)) plistText = redactPlistText(readFileSync(sb.plistPath, "utf-8"));
  } catch (err) {
    plistText = `(unreadable: ${err instanceof Error ? err.message : String(err)})`;
  }
  section(`plist ${sb.plistPath}`, plistText);
  const passFile = join(sb.tmpHome, ".flair", "admin-pass");
  let passState = "absent";
  try {
    if (existsSync(passFile)) passState = `present, mode ${(statSync(passFile).mode & 0o777).toString(8)}`;
  } catch (err) {
    passState = `unstat-able: ${err instanceof Error ? err.message : String(err)}`;
  }
  out.push(`admin-pass file ${passFile}: ${passState} (content never printed)`);
  const pidFile = readPidFile(sb.dataDir);
  out.push(`hdb.pid: ${pidFile ?? "none"}${pidFile ? (isAlive(pidFile) ? " (alive)" : " (dead)") : ""}`);
  const logs = logFilesUnder(sb.tmpHome, 5);
  out.push(`log files under the fixture HOME (${logs.length}): ${logs.join(", ") || "none"}`);
  for (const f of logs.slice(0, DIAG_MAX_LOG_FILES)) {
    let text = "";
    try {
      text = readFileSync(f, "utf-8");
    } catch (err) {
      text = `(unreadable: ${err instanceof Error ? err.message : String(err)})`;
    }
    section(`log ${f} (${text.length} chars)`, text);
  }
  const pids = new Set<number>();
  if (pidFile) pids.add(pidFile);
  const launchdPid = parseLaunchctlList(listed.stdout).pid;
  if (launchdPid) pids.add(launchdPid);
  for (const p of [...listeningPids(sb.httpPort), ...listeningPids(sb.opsPort)]) pids.add(p);
  if (sb.direct?.pid) pids.add(sb.direct.pid);
  out.push(`fixture pids: hdb.pid=${pidFile ?? "none"} launchd=${launchdPid ?? "none"} http-listeners=[${listeningPids(sb.httpPort).join(",")}] direct=${sb.direct?.pid ?? "none"}`);
  section("ps (fixture pids)", pids.size ? runDiag("ps", ["-o", "pid,ppid,stat,lstart,etime,command", "-p", [...pids].join(",")]) : "(no fixture pid known)");
  const all = spawnSync("ps", ["-axo", "pid,ppid,stat,etime,command"], { encoding: "utf-8", timeout: 5_000 }).stdout ?? "";
  section("ps (processes naming the fixture HOME)", all.split("\n").filter((l) => l.includes(sb.tmpHome)).join("\n") || "(none)");
  console.error(out.join("\n"));
}

/** Run a case body; on failure, print diagnostics for the newest sandbox, then fail as before. */
function diagnosed(body: () => Promise<void>): () => Promise<void> {
  return async () => {
    try {
      await body();
    } catch (err) {
      const sb = live[live.length - 1];
      if (sb) {
        try {
          dumpDiagnostics(sb, err instanceof Error ? err.message : String(err));
        } catch (diagErr) {
          console.error(`flair#2040 diagnostics themselves failed: ${diagErr instanceof Error ? diagErr.message : String(diagErr)}`);
        }
      }
      throw err;
    }
  };
}

function trackJob(label: string, plistPath: string): void {
  LOADED_JOBS.add({ label, plistPath });
}

function unloadTracked(): void {
  for (const job of LOADED_JOBS) {
    try {
      unloadJob(job.label, job.plistPath);
      LOADED_JOBS.delete(job);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
    }
  }
}

if (!skipFixtureCase) {
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
  trackJob(label, plistPath);
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
  const managedPid = parseLaunchctlList(launchctlList(sb.label).stdout).pid;
  const managedStart = managedPid === null ? null : readProcessStartSecondMs(managedPid);
  const restored = verifyIdentity({
    pidfilePid: readPidFile(sb.dataDir),
    sidecar: readSidecar(sb.dataDir),
    readStartTime: readProcessStartTimeMs,
  });
  const restoredPid = restored.kind === "verified" ? restored.pid : null;
  const restoredStart = restoredPid === null ? null : readProcessStartSecondMs(restoredPid);
  await cleanupLaunchdSandbox(LOADED_JOBS, sb.launchAgentsDir, async () => {
    const stopOwned = async (pid: number, stillOwned: () => boolean): Promise<void> => {
      if (!stillOwned() || !isAlive(pid)) return;
      try { process.kill(pid, "SIGTERM"); } catch { return; }
      try {
        await waitDead(pid, 2_000);
      } catch {
        if (!stillOwned()) return;
        try { process.kill(pid, "SIGKILL"); } catch { return; }
        await waitDead(pid, 2_000);
      }
    };
    const results = await Promise.allSettled([
      sb.direct?.pid
        ? stopOwned(sb.direct.pid, () => sb.direct!.exitCode === null && sb.direct!.signalCode === null)
        : Promise.resolve(),
      managedPid !== null && managedStart !== null
        ? stopOwned(managedPid, () => readProcessStartSecondMs(managedPid) === managedStart)
        : Promise.resolve(),
      restoredPid !== null && restoredStart !== null && restoredPid !== managedPid && restoredPid !== sb.direct?.pid
        ? stopOwned(restoredPid, () => readProcessStartSecondMs(restoredPid) === restoredStart)
        : Promise.resolve(),
      sb.populate ? stopHarper(sb.populate, { keepInstallDir: true }) : Promise.resolve(),
    ]);
    const failures = results.filter((r) => r.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map((r) => r.reason), `teardown failed for ${sb.tmpHome}`);
    rmSync(sb.tmpHome, { recursive: true, force: true });
  });
}

afterEach(async () => {
  const cases = [...live];
  const results = await Promise.allSettled(cases.map(async (sb) => {
    await teardown(sb);
    live.splice(live.indexOf(sb), 1);
  }));
  lastCliRun = undefined;
  const failures = results.filter((r) => r.status === "rejected");
  if (failures.length) throw new AggregateError(failures.map((r) => r.reason), "fixture teardown failed");
}, 60_000);

function assertNoPrompt(log: string, cliOut: string): void {
  expect(log, `StandardErrorPath contained a readline/prompt:\n${log}`).not.toMatch(PROMPT_RE);
  expect(cliOut, `doctor --fix itself prompted:\n${cliOut}`).not.toMatch(PROMPT_RE);
}

function assertSecretFreePlist(plistPath: string): void {
  const raw = readFileSync(plistPath, "utf-8");
  expect(raw.includes("HDB_ADMIN_PASSWORD"), "regenerated plist must not embed the admin password").toBe(false);
  // Value, not just the key name — a leak under a different key must still fail.
  expect(raw.includes(ADMIN_PASS), "regenerated plist must not embed the admin password value").toBe(false);
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
  // MQTT_* stay. buildDirectSpawnEnv is the production direct-spawn
  // contract (flair#1586); doctor --fix must leave harper-config.yaml
  // byte-identical even when this detach persists them (#1581).
  const proc = spawn(nodeBin(), [harper.path, "run", "."], {
    cwd: REPO_ROOT,
    env,
    detached: true,
    stdio: "ignore",
  });
  proc.unref();
  sb.direct = proc;
  if (!proc.pid) throw new Error("direct spawn produced no pid");
  // flair writes a flair#1454 identity sidecar whenever IT starts Harper
  // directly (`flair start`/`flair init`); this spawn bypasses flair, so write
  // a production-shaped sidecar immediately after spawn, before the health
  // wait, as service.ts does. Without it, doctor can self-heal only with a
  // safe data dir, a live pidfile PID, flair-identified /Health, and no known
  // port-owner or worktree mismatch (unavailable evidence is permitted).
  // If self-heal does not fire here, doctor refuses to adopt with "no identity
  // sidecar" — the observed signature (flair#2130).
  writeDirectSidecar(sb, proc.pid);
  await waitForHttp(sb.httpURL, 60_000);
  const listenerPids = [...new Set(listeningPids(sb.httpPort))].sort((a, b) => a - b);
  expect(listenerPids, "the HTTP port's listener PID set must be exactly the direct-spawned PID before doctor --fix").toEqual([proc.pid]);
  assertDirectSidecar(sb, proc.pid);
  return proc.pid;
}

/** A production-shaped flair#1454 sidecar for the fixture's direct spawn. */
function writeDirectSidecar(sb: Sandbox, pid: number): void {
  const sidecar = {
    pid,
    startTimeMs: Date.now(),
    port: sb.httpPort,
    flairVersion: "test",
  };
  const tmp = join(sb.dataDir, `.flair-daemon.json.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(sidecar, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
  renameSync(tmp, join(sb.dataDir, "flair-daemon.json"));
  chmodSync(join(sb.dataDir, "flair-daemon.json"), 0o600);
}

/** Pin the sidecar before doctor can reconstruct one from a missing file. */
function assertDirectSidecar(sb: Sandbox, spawnedPid: number): void {
  const sidecarPath = join(sb.dataDir, "flair-daemon.json");
  const sidecar = readSidecar(sb.dataDir);
  expect(sidecar, "direct spawn must write its own sidecar before doctor --fix").toMatchObject({
    kind: "present",
    pid: spawnedPid,
    port: sb.httpPort,
    flairVersion: "test",
  });
  expect(statSync(sidecarPath).mode & 0o777, "direct sidecar must be 0600").toBe(0o600);
  expect(verifyIdentity({
    pidfilePid: readPidFile(sb.dataDir),
    sidecar,
    readStartTime: readProcessStartTimeMs,
  }), "pidfile and sidecar must identify the spawned process with a matching start time before doctor --fix").toEqual({
    kind: "verified",
    pid: spawnedPid,
  });
}

test.skipIf(skipFixtureCase)(
  "cleanup refusal retains the fixture label and root",
  diagnosed(async () => {
    requireCliBuild();
    const sb = await newSandbox();
    const refusedCleanup = cleanupLaunchdSandbox(LOADED_JOBS, sb.launchAgentsDir, async () => {
      rmSync(sb.tmpHome, { recursive: true, force: true });
    }, (label, path) => unloadJob(label, path, (args, timeout) => {
      if (args[0] !== "print") return { status: 1, stderr: "fixture refusal" };
      return spawnSync("launchctl", args, { encoding: "utf-8", timeout });
    }));
    await expect(refusedCleanup).rejects.toThrow(`launchd cleanup ${sb.label}: job is still loaded`);
    expect([...LOADED_JOBS].some(job => job.label === sb.label)).toBe(true);
    expect(existsSync(sb.tmpHome)).toBe(true);
    expect(launchctlList(sb.label).code).toBe(0);
  }),
  900_000,
);

test.skipIf(skipFixtureCase)(
  "inherited external Harper URL skips fixture cases",
  async () => {
    let requests = 0;
    const external = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        requests++;
        return new Response("unexpected external request", { status: 500 });
      },
    });
    try {
      const child = Bun.spawn([process.execPath, "test", import.meta.path], {
        cwd: REPO_ROOT,
        env: { ...process.env, HARPER_HTTP_URL: String(external.url) },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 20_000,
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code, stderr).toBe(0);
      expect(stdout).toContain("HARPER_HTTP_URL is set; requires locally spawned Harper");
      expect(stderr).toMatch(/0 pass/);
      expect(requests).toBe(0);
    } finally {
      external.stop(true);
    }
  },
  30_000,
);

test.skipIf(skipFixtureCase)(
  "adopt listener-probe failure attempts restoration of a real Harper instance",
  diagnosed(async () => {
    requireCliBuild();
    const sb = await newSandbox();
    await stopManagedHarper(sb);
    const directPid = await directSpawnDetached(sb);
    assertDirectSidecar(sb, directPid);
    const shimDir = join(sb.tmpHome, "probe-bin");
    const failedProbe = join(sb.tmpHome, "failed-probe");
    mkdirSync(shimDir);
    writeFileSync(join(shimDir, "lsof"), `#!/bin/sh
if ! /bin/kill -0 "$ADOPT_TEST_PID" 2>/dev/null && [ ! -e "$ADOPT_TEST_PROBE" ]; then
  touch "$ADOPT_TEST_PROBE"
  exit 2
fi
exec /usr/sbin/lsof "$@"
`, { mode: 0o700 });
    const script = `import { repairLaunchdManagement } from ${JSON.stringify(CLI_JS)};
const result = await repairLaunchdManagement(${JSON.stringify(sb.dataDir)}, ${sb.httpPort});
console.log("REPAIR_RESULT:" + JSON.stringify(result));`;
    // Async, never spawnSync: the direct Harper is THIS runner's child
    // (directSpawnDetached), and only a running event loop reaps it. Blocked in
    // spawnSync, the stopped Harper stayed a zombie, which kill(pid, 0) reports
    // alive — both doctor's liveness probe and the shim's guard — so the stop
    // ran out its deadline and the fault was never injected (CI, 605498d6). In
    // production the direct process is reparented to launchd, which reaps it.
    const child = spawn(nodeBin(), ["--input-type=module", "-e", script], {
      cwd: REPO_ROOT,
      env: {
        ...doctorEnv(sb.tmpHome),
        PATH: `${shimDir}:${process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin"}`,
        ADOPT_TEST_PID: String(directPid),
        ADOPT_TEST_PROBE: failedProbe,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    const startedAt = Date.now();
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 180_000);
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        resolveExit({ code, signal });
      });
    });
    lastCliRun = { what: "repairLaunchdManagement (lsof fault)", exitCode: exit.code, signal: exit.signal, elapsedMs: Date.now() - startedAt, stdout, stderr };
    const result = { stdout, stderr };
    expect(exit.signal, stdout + stderr).toBeNull();
    expect(exit.code, stdout + stderr).toBe(0);
    expect(existsSync(failedProbe), `the lsof shim never failed a probe after the direct process exited:\n${stdout}${stderr}`).toBe(true);
    const line = result.stdout.split("\n").find((value) => value.startsWith("REPAIR_RESULT:"));
    expect(line).toBeDefined();
    const repair = JSON.parse(line!.slice("REPAIR_RESULT:".length));
    expect(repair.kind).toBe("failed");
    expect(repair.detail).toContain("Final listener probe failed");
    expect(repair.detail).toContain("Flair was restarted directly");
    expect(repair.remedy).toEqual(["flair doctor --fix"]);
    expect(isAlive(directPid)).toBe(false);
    const restoredPid = instancePid(sb.dataDir, sb.httpPort);
    expect(restoredPid).not.toBeNull();
    expect(restoredPid).not.toBe(directPid);
    expect(launchctlList(sb.label).code).not.toBe(0);
    expect(isAlive(restoredPid!)).toBe(true);
    const health = await fetch(`${sb.httpURL}/Health`, { signal: AbortSignal.timeout(2_000) });
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true });
  }),
  850_000,
);

test.skipIf(skipFixtureCase)(
  "corrupt or missing launchd plist: doctor --fix regenerates and comes up managed",
  diagnosed(async () => {
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
  }),
  CORRUPT_PLIST_CASE_BUDGET_MS,
);

test.skipIf(skipFixtureCase)(
  "detached direct-spawned instance: doctor --fix adopts into launchd, bouncing once",
  diagnosed(async () => {
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
    await assertNoRebootstrap(sb, before);
    expect(result.stdout + result.stderr).toMatch(/adopt|bounc/i);
    // flair#1701: the adopt bounce is the first launchd start. Harper recreates
    // operations-server at 0777 & ~umask. Darwin chmod on that AF_UNIX inode
    // does not persist 0600 (#1704 CI). launchd Umask 077 makes bind() 0700;
    // doctor classify treats 0700 and 0600 as default-clean. Group/world bits
    // (0755) are the canary-red finding — do not allow-list those.
    const socketPath = join(sb.dataDir, "operations-server");
    // HTTP up does not mean the operations socket is bound yet: wait for it, bounded.
    const socketStat = await waitForSocket(socketPath, 10_000);
    expect(statSync(sb.dataDir).mode & 0o777, "data dir must be 0700 after first adopt start").toBe(0o700);
    const socketMode = socketStat.mode & 0o777;
    expect(socketMode & 0o077, "ops socket must be owner-only after first adopt start").toBe(0);
    expect(
      socketMode === 0o600 || socketMode === 0o700,
      `ops socket must be 0600 or 0700 after first adopt start, got ${socketMode.toString(8)}`,
    ).toBe(true);
    await new Promise((r) => setTimeout(r, 2_000));
    expect(instancePid(sb.dataDir, sb.httpPort), "PID must stay stable after adopt (no KeepAlive restart loop)").toBe(
      managed.pid,
    );
  }),
  ADOPT_DETACHED_CASE_BUDGET_MS,
);

test.skipIf(skipFixtureCase)(
  "adopt with NO pass file and a proven env credential: doctor writes the 0600 file and adopts (flair#1685)",
  diagnosed(async () => {
    requireCliBuild();
    const sb = await newSandbox();
    const before = await snapshotBeforeFix(sb);
    const managedPid = instancePid(sb.dataDir, sb.httpPort);
    await stopManagedHarper(sb);
    const detachedPid = await directSpawnDetached(sb);
    expect(detachedPid).not.toBe(managedPid);
    const passFile = join(sb.tmpHome, ".flair", "admin-pass");
    // The #1685 gap: the direct-spawned instance is live, but the pass file the
    // adopted plist's launcher needs does not exist. FLAIR_ADMIN_PASS is set to
    // the instance's real password, so adoption must PROVE it against the live
    // instance, write the file 0600, and only then write the plist.
    rmSync(passFile, { force: true });
    expect(existsSync(passFile)).toBe(false);
    clearLaunchdLogs(sb.dataDir);

    const result = await doctorFixToManaged(sb);
    const managed = assertManaged(sb);
    expect(existsSync(passFile), "doctor --fix must create the admin-pass file").toBe(true);
    expect(statSync(passFile).mode & 0o777, "the created pass file must be 0600").toBe(0o600);
    expect(readFileSync(passFile, "utf-8").replace(/\s+$/, "")).toBe(ADMIN_PASS);
    expect(isAlive(detachedPid), `adopt must clean-stop the direct pid ${detachedPid}`).toBe(false);
    expect(managed.pid, "serving pid must CHANGED from the direct pid").not.toBe(detachedPid);
    assertSecretFreePlist(sb.plistPath);
    expect(result.stdout + result.stderr).toMatch(/adopt|bounc/i);
    await assertNoRebootstrap(sb, before);
  }),
  ADOPT_NO_PASS_CASE_BUDGET_MS,
);

test.skipIf(skipFixtureCase)(
  "regenerate with NO pass file, no live process, and no env credential: refuse and write no plist (flair#1685)",
  diagnosed(async () => {
    requireCliBuild();
    const sb = await newSandbox();
    // Instance DOWN: unload the job and remove the pass file, then move the
    // existing (valid) plist aside so any plist found after doctor --fix was
    // provably written by it.
    await stopManagedHarper(sb);
    const passFile = join(sb.tmpHome, ".flair", "admin-pass");
    rmSync(passFile, { force: true });
    const movedAside = `${sb.plistPath}.1685-bak`;
    rmSync(movedAside, { force: true });
    writeFileSync(movedAside, readFileSync(sb.plistPath));
    rmSync(sb.plistPath, { force: true });
    expect(existsSync(passFile)).toBe(false);
    expect(existsSync(sb.plistPath)).toBe(false);

    const result = await runDoctorFix(sb.tmpHome, sb.httpPort, { adminPassEnv: false });
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).not.toBe(0);
    expect(existsSync(passFile), "a refusal must not create the pass file").toBe(false);
    expect(
      existsSync(sb.plistPath),
      "a refusal must not leave a launchd plist whose launcher needs the missing pass file",
    ).toBe(false);
    expect(result.stdout + result.stderr).toMatch(/admin-pass|flair init/i);
  }),
  REFUSE_NO_PASS_CASE_BUDGET_MS,
);

test.skipIf(skipFixtureCase)(
  "flair init on an already-adopted instance leaves the plist byte-identical (flair#1693)",
  diagnosed(async () => {
    requireCliBuild();
    const sb = await newSandbox();
    // newSandbox() has already adopted via doctor --fix, so the on-disk plist
    // IS the #1573 pass-file shape. `flair init` must not touch it.
    const before = readFileSync(sb.plistPath, "utf-8");
    expect(before).toContain("start-flair-with-admin-pass.sh");
    expect(before).not.toContain("HDB_ADMIN_PASSWORD");

    const result = await runInit(sb.tmpHome, sb.httpPort);

    const after = readFileSync(sb.plistPath, "utf-8");
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(after, "flair init must not rewrite an adopted plist (#1693)").toBe(before);
    expect(after).not.toContain("HDB_ADMIN_PASSWORD");
    expect(result.stdout + result.stderr).toMatch(/unchanged|already managed/i);
    const managed = assessManaged(sb.dataDir, sb.httpPort, sb.launchAgentsDir);
    expect(managed.state, managed.detail).toBe("managed");
  }),
  INIT_UNCHANGED_CASE_BUDGET_MS,
);

test.skipIf(skipFixtureCase)(
  "built flair stop verifies the managed Harper exited and removes its sidecar",
  diagnosed(async () => {
    requireCliBuild();
    const sb = await newSandbox();
    const pid = instancePid(sb.dataDir, sb.httpPort);
    expect(pid).not.toBeNull();
    if (pid === null) throw new Error("managed Harper PID is unreadable");
    expect(isAlive(pid)).toBe(true);
    writeDirectSidecar(sb, pid);
    const result = spawnSync(nodeBin(), [CLI_JS, "stop", "--port", String(sb.httpPort)], {
      cwd: REPO_ROOT,
      env: doctorEnv(sb.tmpHome),
      encoding: "utf8",
      timeout: 90_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("Flair stopped (launchd service unloaded)");
    expect(isAlive(pid)).toBe(false);
    expect(existsSync(join(sb.dataDir, "flair-daemon.json"))).toBe(false);
  }),
  750_000,
);


test.skipIf(skipFixtureCase)(
  "restart removes the old launchd sidecar before starting its replacement",
  diagnosed(async () => {
    requireCliBuild();
    const sb = await newSandbox();
    const pid = instancePid(sb.dataDir, sb.httpPort);
    expect(pid).not.toBeNull();
    if (pid === null) throw new Error("managed Harper PID is unreadable");
    writeDirectSidecar(sb, pid);
    const script = `
      import { existsSync } from "node:fs";
      import { join } from "node:path";
      import { program, restartFlair } from ${JSON.stringify(pathToFileURL(CLI_JS).href)};
      await restartFlair(${sb.httpPort}, ${JSON.stringify(sb.dataDir)}, {
        startReplacement: async () => {
          if (existsSync(join(${JSON.stringify(sb.dataDir)}, "flair-daemon.json"))) {
            throw new Error("old sidecar remains before replacement start");
          }
          await program.parseAsync(["node", "flair", "start", "--port", ${JSON.stringify(String(sb.httpPort))}]);
        },
      });
    `;
    const result = spawnSync(nodeBin(), ["--input-type=module", "-e", script], {
      cwd: REPO_ROOT,
      env: doctorEnv(sb.tmpHome),
      encoding: "utf8",
      timeout: 180_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(isAlive(pid)).toBe(false);
    const managed = assertManaged(sb);
    expect(managed.pid).not.toBe(pid);
    expect(readSidecar(sb.dataDir)).toMatchObject({ kind: "present", pid: managed.pid });
  }),
  850_000,
);
