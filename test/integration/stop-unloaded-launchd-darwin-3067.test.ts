// stop-unloaded-launchd-darwin-3067.test.ts — flair#3067, real seam.
//
// The unit cases drive `flair stop` against node stubs and a launchctl shim.
// This file is the other half: a real `flair init` with a real Harper, a real
// launchd, and the real `flair stop` binary in a scratch HOME.
//
// A fresh init writes the instance's plist but starts Harper directly, so the
// job is not loaded. `launchctl list <label>` must answer 113, /Health must be
// ok, and `flair stop` must stop the recorded pid through the direct path —
// the message names that path.
//
// Linux CI cannot run this: it needs Darwin's launchd and a real Harper boot.
// Every case is gated on darwin and skips elsewhere. The macOS
// `test-darwin-gated` job runs this file explicitly; it is not in the #1012
// unit inventory (scripts/check-darwin-gated-tests.mjs skips test/integration*).
//
// SAFETY — HOME is a throwaway directory and the CLI is a spawned
// `node dist/cli.js`, so Node honours HOME before start and every plist, data
// dir and label resolves inside the fixture. Teardown stops the recorded pid
// and removes that one directory; it never signals by pattern.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { harperPortValue, launchdLabel, launchdPlistPath, readHarperConfig } from "../../src/cli.ts";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle.ts";
import { nodeBin } from "../helpers/node-runtime.ts";

const isDarwin = process.platform === "darwin";
const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const CLI_JS = join(REPO_ROOT, "dist", "cli.js");
const MODELS_DIR = join(REPO_ROOT, "models");
const ADMIN_USER = "admin";
const ADMIN_PASS = "test123";

const live: Array<{ home: string; dataDir: string; label: string; plistPath: string; pid?: number; populate?: HarperInstance; direct?: ChildProcess }> = [];

function stripAmbientFlair(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (/^(FLAIR_|HARPER_|HDB_|FABRIC_)/.test(k)) continue;
    out[k] = v;
  }
  return out;
}

// No FLAIR_ADMIN_PASS or HDB_ADMIN_PASSWORD: `flair init` resolves an env
// credential before the reuse branch, so the fixture's ~/.flair/admin-pass is
// the source here — the same env runInit uses in
// doctor-fix-launchd-darwin.test.ts.
function cliEnv(home: string): Record<string, string> {
  return {
    ...stripAmbientFlair(process.env),
    HOME: home,
    FLAIR_MODELS_DIR: MODELS_DIR,
    HDB_ADMIN_USERNAME: ADMIN_USER,
  };
}

function requireCliBuild(): void {
  if (!existsSync(CLI_JS)) {
    throw new Error(`dist/cli.js is missing — run: bun run build && bun run build:cli`);
  }
}

function readPidFile(dataDir: string): number | null {
  const path = join(dataDir, "hdb.pid");
  if (!existsSync(path)) return null;
  const n = Number(readFileSync(path, "utf-8").trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
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

async function waitForHealth(url: string, timeoutMs: number): Promise<{ ok: boolean; body: any }> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      const text = await res.text();
      if (res.status > 0) return { ok: res.ok, body: text.length > 0 ? JSON.parse(text) : null };
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`no response from ${url} within ${timeoutMs}ms (${last})`);
}

function runCli(home: string, args: string[]): { status: number | null; signal: string | null; stdout: string; stderr: string } {
  requireCliBuild();
  const res = spawnSync(nodeBin(), [CLI_JS, ...args], {
    cwd: REPO_ROOT,
    env: cliEnv(home),
    encoding: "utf8",
    timeout: 120_000,
    killSignal: "SIGKILL",
  });
  return { status: res.status, signal: res.signal, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function launchctlList(label: string): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync("launchctl", ["list", label], { encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL" });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

async function spawnDirectHarper(dataDir: string): Promise<HarperInstance> {
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(dataDir, "log"), { recursive: true });
  return startHarper({ installDir: dataDir });
}

test.skipIf(!isDarwin)(
  "real fresh init: plist on disk, job not loaded (113), /Health ok, stop stops the recorded pid directly",
  async () => {
    requireCliBuild();
    const home = mkdtempSync(join(tmpdir(), "flair3067-home-"));
    const dataDir = resolve(join(home, ".flair", "data"));
    const launchAgentsDir = join(home, "Library", "LaunchAgents");
    mkdirSync(launchAgentsDir, { recursive: true });
    const label = launchdLabel(dataDir);
    const plistPath = launchdPlistPath(label, launchAgentsDir);
    const entry: (typeof live)[number] = { home, dataDir, label, plistPath };
    live.push(entry);

    // The persisted admin credential `flair init` reuses, written before the
    // populate boot as doctor-fix-launchd-darwin.test.ts writes it.
    const passDir = join(home, ".flair");
    mkdirSync(passDir, { recursive: true });
    const passFile = join(passDir, "admin-pass");
    writeFileSync(passFile, `${ADMIN_PASS}\n`, { mode: 0o600 });
    chmodSync(passFile, 0o600);

    // A real Harper installation, so `flair init` finds it and starts it
    // directly instead of installing one.
    const populate = await spawnDirectHarper(dataDir);
    entry.populate = populate;
    const httpPort = Number(new URL(populate.httpURL).port);
    const opsPort = Number(new URL(populate.opsURL).port);
    await stopHarper(populate, { keepInstallDir: true });
    entry.populate = undefined;
    const cfg = readHarperConfig(dataDir);
    const configPort = harperPortValue(cfg?.http?.port) ?? httpPort;
    const configOpsPort = harperPortValue(cfg?.operationsApi?.network?.port) ?? opsPort;
    if (configPort !== httpPort) throw new Error(`config port ${configPort} differs from the booted port ${httpPort}`);

    const init = runCli(home, ["init", "--port", String(configPort), "--ops-port", String(configOpsPort), "--no-mcp", "--skip-soul"]);
    expect(init.signal, `flair init overran:\n${init.stdout}\n${init.stderr}`).toBeNull();
    expect(init.status, `flair init failed:\n${init.stdout}\n${init.stderr}`).toBe(0);

    // The plist exists and launchd does not have the job: the fresh-init shape.
    expect(existsSync(plistPath), `flair init did not write ${plistPath}`).toBe(true);
    const listed = launchctlList(label);
    expect(listed.status, `launchctl list ${label} should exit 113, got ${listed.status}:\n${listed.stdout}${listed.stderr}`).toBe(113);

    const health = await waitForHealth(`http://127.0.0.1:${configPort}/Health`, 60_000);
    expect(health.ok, "the real /Health is not ok").toBe(true);
    expect(health.body?.ok).toBe(true);

    const recordedPid = readPidFile(dataDir);
    expect(recordedPid, "flair init's direct process did not record a pid").not.toBeNull();
    expect(isAlive(recordedPid!), "the recorded pid is not alive before stop").toBe(true);

    const stop = runCli(home, ["stop", "--port", String(configPort)]);
    expect(stop.signal, `flair stop overran:\n${stop.stdout}\n${stop.stderr}`).toBeNull();
    expect(stop.status, `flair stop failed:\n${stop.stdout}\n${stop.stderr}`).toBe(0);
    expect(stop.stdout).toContain(`stopped the directly started Flair (pid ${recordedPid})`);
    expect(stop.stdout).toContain(`the launchd job ${label} was not loaded`);

    await waitDead(recordedPid!, 20_000);
    expect(isAlive(recordedPid!)).toBe(false);
    expect(launchctlList(label).status, "stop must not load the job").toBe(113);
  },
  600_000,
);

afterEach(async () => {
  for (const entry of live.splice(0)) {
    if (entry.direct?.pid) {
      try { process.kill(entry.direct.pid, "SIGKILL"); } catch { /* gone */ }
    }
    const pid = entry.pid ?? readPidFile(entry.dataDir);
    if (pid !== null && isAlive(pid)) {
      try { process.kill(pid, "SIGTERM"); } catch { /* gone */ }
      await waitDead(pid, 5_000).catch(() => {
        try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
      });
    }
    if (entry.populate) await stopHarper(entry.populate, { keepInstallDir: true }).catch(() => undefined);
    rmSync(entry.home, { recursive: true, force: true });
  }
}, 60_000);
