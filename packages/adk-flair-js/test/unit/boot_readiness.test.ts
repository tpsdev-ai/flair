import { test, expect, mock } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { writeFileSync, readFileSync, mkdtempSync, unlinkSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { bootEphemeralHarper } from "../helpers/live-flair";
import { waitForAppLoaded } from "../../../adk-flair/tests/helpers/app-readiness.mjs";
import { parseProcStatState, isExitedState } from "../../../../src/lib/daemon-liveness.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_TIMEOUT_MS = 5_000;
const PROCESS_WAIT_TIMEOUT_MS = 2_000;
const PROCESS_POLL_INTERVAL_MS = 10;
const MOCK_LIFETIME_TIMEOUT_MS = 10_000;
const MOCK_TEARDOWN_TIMEOUT_MS = 2_000;
const BOOT_CONFIG_TIMEOUT_MS = 10;
const BOOT_ASSERTION_TIMEOUT_MS = 100;
const APP_TEST_TIMEOUT_MS = 2_000;
const APP_TEST_PROBE_TIMEOUT_MS = 10;

function readiness(request: (...args: any[]) => Promise<any>) {
  let clock = 0;
  const sleep = mock(async (ms: number) => { clock += ms; });
  return { request: mock(request), now: () => clock, sleep, probeTimeoutMs: APP_TEST_PROBE_TIMEOUT_MS };
}

for (const status of [200, 405]) {
  test(`waitForAppLoaded resolves when /Memory returns ${status}`, async () => {
    const deps = readiness(async () => ({ status }));
    await waitForAppLoaded("http://fixture.invalid", APP_TEST_TIMEOUT_MS, deps);
    expect(deps.request).toHaveBeenCalledTimes(1);
    expect(deps.request.mock.calls[0][0]).toBe("http://fixture.invalid/Memory");
    expect(deps.request.mock.calls[0][1].method).toBe("GET");
    expect(deps.sleep).not.toHaveBeenCalled();
  }, TEST_TIMEOUT_MS);
}

test("waitForAppLoaded throws when /Memory returns 404 (app not loaded)", async () => {
  const deps = readiness(async () => ({ status: 404 }));
  await expect(waitForAppLoaded("http://fixture.invalid", APP_TEST_TIMEOUT_MS, deps))
    .rejects.toThrow("after 2000ms (4 attempts)");
  expect(deps.now()).toBe(APP_TEST_TIMEOUT_MS);
}, TEST_TIMEOUT_MS);

test("waitForAppLoaded throws when server is unreachable", async () => {
  const deps = readiness(async () => { throw new Error("ECONNREFUSED"); });
  await expect(waitForAppLoaded("http://fixture.invalid", APP_TEST_TIMEOUT_MS, deps))
    .rejects.toThrow("Flair application not loaded");
  expect(deps.request).toHaveBeenCalledTimes(4);
}, TEST_TIMEOUT_MS);

test("waitForAppLoaded eventually resolves when app loads after delay", async () => {
  let calls = 0;
  const deps = readiness(async () => ({ status: ++calls <= 3 ? 404 : 200 }));
  await waitForAppLoaded("http://fixture.invalid", APP_TEST_TIMEOUT_MS, deps);
  expect(calls).toBe(4);
  expect(deps.sleep).toHaveBeenCalledTimes(3);
}, TEST_TIMEOUT_MS);

test("waitForAppLoaded aborts an unfinished probe", async () => {
  const deps = readiness((_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));
  await expect(waitForAppLoaded("http://fixture.invalid", APP_TEST_TIMEOUT_MS, deps))
    .rejects.toThrow("Flair application not loaded");
  expect(deps.request).toHaveBeenCalledTimes(4);
}, TEST_TIMEOUT_MS);

test("waitForAppLoaded does not sleep past its deadline", async () => {
  const deps = readiness(async () => ({ status: 404 }));
  await expect(waitForAppLoaded("http://fixture.invalid", 1, deps)).rejects.toThrow("after 1ms");
  expect(deps.now()).toBe(1);
}, TEST_TIMEOUT_MS);

async function within<T>(name: string, promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${name} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

function bootProcess() {
  const proc = new EventEmitter() as ChildProcess;
  proc.stdout = new PassThrough() as any;
  proc.stderr = new PassThrough() as any;
  proc.kill = mock(() => true);
  return proc;
}

test("bootEphemeralHarper rejects and kills a helper that never emits config", async () => {
  const proc = bootProcess();
  const spawnProcess = mock(() => proc) as unknown as typeof spawn;
  try {
    await expect(within("boot helper timeout rejection",
      bootEphemeralHarper("unused.mjs", BOOT_CONFIG_TIMEOUT_MS, "node", spawnProcess), BOOT_ASSERTION_TIMEOUT_MS))
      .rejects.toThrow("boot-harper timed out");
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
  } finally {
    proc.stdout?.destroy();
    proc.stderr?.destroy();
  }
}, TEST_TIMEOUT_MS);

test("bootEphemeralHarper rejects when a helper exits without config", async () => {
  const proc = bootProcess();
  const spawnProcess = mock(() => proc) as unknown as typeof spawn;
  const result = bootEphemeralHarper("unused.mjs", BOOT_CONFIG_TIMEOUT_MS, "node", spawnProcess);
  proc.emit("exit", 0);
  await expect(within("boot helper early-exit rejection", result, BOOT_ASSERTION_TIMEOUT_MS)).rejects.toThrow("before config");
  proc.stdout?.destroy();
  proc.stderr?.destroy();
}, TEST_TIMEOUT_MS);

async function waitUntil(name: string, predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + PROCESS_WAIT_TIMEOUT_MS;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`${name} timed out after ${PROCESS_WAIT_TIMEOUT_MS}ms`);
    await new Promise(resolve => setTimeout(resolve, PROCESS_POLL_INTERVAL_MS));
  }
}

function waitForExit(proc: ChildProcess, name: string): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); proc.off("exit", onExit); proc.off("error", onError); };
    const onExit = () => { cleanup(); resolve(); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const timer = setTimeout(() => { cleanup(); reject(new Error(`${name} timed out`)); }, PROCESS_WAIT_TIMEOUT_MS);
    proc.once("exit", onExit);
    proc.once("error", onError);
  });
}

// ─── Recovery contract (flair#1121) ─────────────────────────────────────────
// The JSON line must include rootPath and harperPid so callers can recover
// from an interrupted teardown.

async function spawnMockBootHelper(jsonFields: Record<string, unknown>): Promise<{
  config: Record<string, unknown>;
  proc: ChildProcess;
}> {
  const scriptPath = join(tmpdir(), `adk-flair-test-mock-boot-${process.pid}.mjs`);
  const jsonLine = JSON.stringify(jsonFields);
  writeFileSync(scriptPath, [
    "#!/usr/bin/env node",
    `process.stdout.write(${JSON.stringify(jsonLine)} + "\\n");`,
    "process.stdin.on('end', () => process.exit(0));",
  ].join("\n"), "utf-8");

  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: PROCESS_WAIT_TIMEOUT_MS,
    });
    let stdout = "";
    const timeout = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch {}
      try { unlinkSync(scriptPath); } catch {}
      reject(new Error("mock boot helper timed out"));
    }, PROCESS_WAIT_TIMEOUT_MS);

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const lines = stdout.split("\n");
      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          const config = JSON.parse(line);
          clearTimeout(timeout);
          // Clean up the temp script
          try { unlinkSync(scriptPath); } catch {}
          resolve({ config, proc });
          return;
        } catch {
          // not JSON yet
        }
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      try { unlinkSync(scriptPath); } catch {}
      reject(err);
    });
  });
}

test("JSON line includes rootPath and harperPid", async () => {
  const { config, proc } = await spawnMockBootHelper({
    httpURL: "http://127.0.0.1:19926",
    opsURL: "http://127.0.0.1:19925",
    adminUser: "admin",
    adminPass: "test123",
    rootPath: "/tmp/flair-test-abc123",
    harperPid: 424242,
    outcome: "BOOTED+WARM",
    floor_ms: 42,
  });

  try {
    expect(config.rootPath).toBe("/tmp/flair-test-abc123");
    expect(config.harperPid).toBe(424242);
    // Backward compat: existing fields still present
    expect(config.httpURL).toBe("http://127.0.0.1:19926");
    expect(config.opsURL).toBe("http://127.0.0.1:19925");
  } finally {
    const exited = waitForExit(proc, "JSON helper exit");
    proc.kill("SIGKILL");
    await exited;
  }
}, TEST_TIMEOUT_MS);

test("JSON line with null harperPid (external mode) still includes the field", async () => {
  const { config, proc } = await spawnMockBootHelper({
    httpURL: "http://127.0.0.1:19926",
    opsURL: "http://127.0.0.1:19925",
    adminUser: "admin",
    adminPass: "test123",
    rootPath: "",
    harperPid: null,
    outcome: "BOOTED+WARM",
    floor_ms: 42,
  });

  try {
    expect(config.rootPath).toBe("");
    expect(config.harperPid).toBeNull();
  } finally {
    const exited = waitForExit(proc, "JSON helper exit");
    proc.kill("SIGKILL");
    await exited;
  }
}, TEST_TIMEOUT_MS);

// ─── Source-level assertion (mutation-checkable) ───────────────────────────
// Directly verifies the boot-harper.mjs source emits rootPath + harperPid in
// the JSON config line. This catches regressions where the fields are removed
// from the source without needing a real Harper boot.

test("boot-harper.mjs source emits rootPath and harperPid in config object", () => {
  const { readFileSync } = require("node:fs");
  const bootHelperPath = join(
    __dirname, "..", "..", "..", "..",
    "packages", "adk-flair", "tests", "helpers", "boot-harper.mjs",
  );
  const source = readFileSync(bootHelperPath, "utf-8");

  // The config object is built right before process.stdout.write
  // Look for rootPath and harperPid keys in the config literal
  expect(source).toMatch(/rootPath:\s*harper\.installDir/);
  expect(source).toMatch(/harperPid:\s*harper\.process\?\.pid/);
});

function writeRecoveryMock(rootPath: string): string {
  const mockScript = join(rootPath, "recovery-mock.mjs");
  writeFileSync(mockScript, [
    "import { spawn } from 'node:child_process';",
    "import { writeFileSync, rmSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "",
    `const ROOT = ${JSON.stringify(rootPath)};`,
    "const parentPid = process.ppid;",
    "",
    `const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, ${MOCK_LIFETIME_TIMEOUT_MS})'], {`,
    "  stdio: 'ignore',",
    "  detached: true,",
    `  timeout: ${MOCK_LIFETIME_TIMEOUT_MS},`,
    "});",
    "writeFileSync(join(ROOT, 'mock-child.pid'), String(child.pid));",
    "",
    "const config = {",
    "  httpURL: 'http://127.0.0.1:19926',",
    "  opsURL: 'http://127.0.0.1:19925',",
    "  adminUser: 'admin',",
    "  adminPass: 'test123',",
    "  rootPath: ROOT,",
    "  harperPid: child.pid,",
    "  outcome: 'BOOTED+WARM',",
    "  floor_ms: 42,",
    "};",
    "process.stdout.write(JSON.stringify(config) + '\\n');",
    "",
    "const reason = await new Promise(resolve => {",
    "  let settled = false;",
    "  const finish = value => {",
    "    if (settled) return;",
    "    settled = true;",
    "    clearInterval(parentCheck);",
    "    clearTimeout(deadline);",
    "    resolve(value);",
    "  };",
    "  const parentCheck = setInterval(() => {",
    "    if (process.ppid !== parentPid) finish('parent');",
    `  }, ${PROCESS_POLL_INTERVAL_MS});`,
    `  const deadline = setTimeout(() => finish('deadline'), ${MOCK_LIFETIME_TIMEOUT_MS});`,
    "  if (process.env.RECOVERY_MOCK_IGNORE_STDIN !== '1') {",
    "    process.stdin.once('end', () => finish('stdin'));",
    "    process.stdin.resume();",
    "  }",
    "});",
    "if (reason === 'stdin') {",
    "  process.stdout.write(JSON.stringify({ teardown: 'started' }) + '\\n');",
    `  await new Promise(r => setTimeout(r, ${MOCK_TEARDOWN_TIMEOUT_MS}));`,
    "}",
    "try { child.kill('SIGKILL'); } catch {}",
    "rmSync(ROOT, { recursive: true, force: true });",
    "if (process.env.RECOVERY_MOCK_EXIT_FILE) {",
    "  writeFileSync(process.env.RECOVERY_MOCK_EXIT_FILE, reason);",
    "}",
    "process.exit(0);",
  ].join("\n"), "utf-8");
  return mockScript;
}

function killPid(pid: number | undefined): void {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return;
  try { process.kill(pid, "SIGKILL"); } catch {}
}

function processRunning(
  pid: number,
  platform = process.platform,
  readStat = (value: number) => readFileSync(`/proc/${value}/stat`, "utf-8"),
): boolean {
  if (platform === "linux") {
    try {
      // The kernel's state character (field 3, parsed past the last `)` because
      // comm may hold spaces and parens) is `Z` for an exited-but-unreaped
      // process (flair#2313).
      return !isExitedState(parseProcStatState(readStat(pid)));
    } catch (error: any) {
      if (error.code === "ENOENT" || error.code === "ESRCH") return false;
      throw error;
    }
  }
  try { process.kill(pid, 0); return true; } catch { return false; }
}

for (const code of ["ENOENT", "ESRCH"]) {
  test(`processRunning treats disappearing /proc (${code}) as exited`, () => {
    expect(processRunning(42, "linux", () => { throw Object.assign(new Error("gone"), { code }); })).toBe(false);
  });
}

test("processRunning treats a Linux zombie as exited", () => {
  expect(processRunning(42, "linux", () => "42 (mock child) Z")).toBe(false);
});

test("processRunning propagates an unreadable Linux process state", () => {
  expect(() => processRunning(42, "linux", () => { throw Object.assign(new Error("unreadable"), { code: "EACCES" }); }))
    .toThrow("unreadable");
});

function recordedMockPid(rootPath: string, name: string): number | undefined {
  try { return Number(readFileSync(join(rootPath, name), "utf-8")); }
  catch { return undefined; }
}

test("SIGKILL mid-teardown: recovery via harperPid + rootPath works (mock)", async () => {
  const rootPath = mkdtempSync(join(tmpdir(), "flair-test-recovery-"));
  writeFileSync(join(rootPath, "hdb.pid"), String(process.pid), "utf-8");
  const mockScript = writeRecoveryMock(rootPath);
  let wrapper: ChildProcess | undefined;
  let harperPid: number | undefined;

  try {
    // ── Spawn the mock wrapper ──────────────────────────────────────────
    wrapper = spawn("node", [mockScript], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: TEST_TIMEOUT_MS,
    });

    // Read the JSON line
    const config = await new Promise<Record<string, unknown>>((resolve, reject) => {
      let stdout = "";
      const timeout = setTimeout(() => {
        try { wrapper.kill("SIGKILL"); } catch {}
        reject(new Error("mock wrapper timed out"));
      }, PROCESS_WAIT_TIMEOUT_MS);

      wrapper.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        const lines = stdout.split("\n");
        for (let i = 0; i < lines.length - 1; i++) {
          const line = lines[i].trim();
          if (!line) continue;
          try {
            const cfg = JSON.parse(line);
            if (cfg.httpURL && cfg.rootPath && cfg.harperPid) {
              clearTimeout(timeout);
              resolve(cfg);
              return;
            }
          } catch { /* not JSON yet */ }
        }
      });

      wrapper.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    harperPid = config.harperPid as number;
    expect(config.rootPath).toBe(rootPath);
    expect(typeof harperPid).toBe("number");
    expect(harperPid).toBeGreaterThan(0);

    // ── Confirm the mock Harper child is alive ───────────────────────────
    let childAlive = true;
    try { process.kill(harperPid, 0); } catch { childAlive = false; }
    expect(childAlive).toBe(true);

    // ── Confirm the tree exists ─────────────────────────────────────────
    expect(existsSync(rootPath)).toBe(true);
    expect(existsSync(join(rootPath, "hdb.pid"))).toBe(true);

    // ── SIGKILL the wrapper mid-teardown ────────────────────────────────
    await new Promise<void>((resolve, reject) => {
      let stdout = "";
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("mock wrapper did not report teardown start within its timeout"));
      }, PROCESS_WAIT_TIMEOUT_MS);
      const onData = (chunk: Buffer) => {
        stdout += chunk.toString();
        let end: number;
        while ((end = stdout.indexOf("\n")) !== -1) {
          const line = stdout.slice(0, end);
          stdout = stdout.slice(end + 1);
          try {
            if (JSON.parse(line).teardown === "started") {
              cleanup();
              resolve();
              return;
            }
          } catch {}
        }
      };
      const onExit = () => {
        cleanup();
        reject(new Error("mock wrapper exited before teardown start marker"));
      };
      const cleanup = () => {
        clearTimeout(timeout);
        wrapper!.stdout?.off("data", onData);
        wrapper!.off("exit", onExit);
      };
      wrapper!.stdout?.on("data", onData);
      wrapper!.once("exit", onExit);
      wrapper!.stdin?.end();
    });
    const exited = waitForExit(wrapper, "killed recovery wrapper exit");
    wrapper.kill("SIGKILL");
    await exited;

    // ── The mock Harper child should still be alive (orphaned) ──────────
    try { process.kill(harperPid, 0); childAlive = true; } catch { childAlive = false; }
    expect(childAlive).toBe(true);

    // ── Exercise the documented recovery path ───────────────────────────
    // 1. Kill by explicit harperPid
    if (childAlive) {
      try { process.kill(harperPid, "SIGKILL"); } catch {}
      await waitUntil("orphaned Harper child exit", () => !processRunning(harperPid!));
    }

    // 2. Remove the tree by rootPath
    if (existsSync(rootPath)) {
      rmSync(rootPath, { recursive: true, force: true, maxRetries: 4 });
    }

    // ── Verify: no process, no tree ─────────────────────────────────────
    expect(processRunning(harperPid)).toBe(false);
    expect(existsSync(rootPath)).toBe(false);
  } finally {
    killPid(wrapper?.pid);
    killPid(harperPid ?? recordedMockPid(rootPath, "mock-child.pid"));
    try { rmSync(rootPath, { recursive: true, force: true, maxRetries: 2 }); } catch {}
  }
}, TEST_TIMEOUT_MS);

test("recovery mock exits when its parent disappears", async () => {
  const rootPath = mkdtempSync(join(tmpdir(), "flair-test-parent-exit-"));
  const exitFile = `${rootPath}.exit`;
  const mockScript = writeRecoveryMock(rootPath);
  const launcherCode = [
    "const { spawn } = require('node:child_process');",
    "const { writeFileSync } = require('node:fs');",
    "const wrapper = spawn(process.execPath, [process.argv[1]], {",
    "  stdio: ['pipe', 'pipe', 'pipe'],",
    "  detached: true,",
    `  timeout: ${TEST_TIMEOUT_MS},`,
    "  env: { ...process.env, RECOVERY_MOCK_IGNORE_STDIN: '1', RECOVERY_MOCK_EXIT_FILE: process.argv[2] },",
    "});",
    "writeFileSync(process.argv[3], String(wrapper.pid));",
    "let stdout = '';",
    "wrapper.stdout.on('data', chunk => {",
    "  stdout += chunk.toString();",
    "  const end = stdout.indexOf('\\n');",
    "  if (end < 0) return;",
    "  const config = JSON.parse(stdout.slice(0, end));",
    "  process.stdout.write(JSON.stringify({ wrapperPid: wrapper.pid, harperPid: config.harperPid }) + '\\n', () => process.exit(0));",
    "});",
    "wrapper.on('error', error => { console.error(error); process.exit(1); });",
  ].join("\n");
  let launcher: ChildProcess | undefined;
  let wrapperPid: number | undefined;
  let harperPid: number | undefined;
  let launcherStderr = "";

  try {
    launcher = spawn("node", ["-e", launcherCode, mockScript, exitFile, join(rootPath, "mock-wrapper.pid")], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: TEST_TIMEOUT_MS,
    });
    launcher.stderr?.on("data", (chunk: Buffer) => { launcherStderr += chunk.toString(); });
    const pids = await new Promise<{ wrapperPid: number; harperPid: number }>((resolve, reject) => {
      let stdout = "";
      const deadline = setTimeout(() => reject(new Error("launcher did not report mock PIDs")), PROCESS_WAIT_TIMEOUT_MS);
      launcher!.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        const end = stdout.indexOf("\n");
        if (end < 0) return;
        clearTimeout(deadline);
        resolve(JSON.parse(stdout.slice(0, end)));
      });
      launcher!.on("error", error => { clearTimeout(deadline); reject(error); });
      launcher!.on("exit", code => {
        if (code !== 0) { clearTimeout(deadline); reject(new Error(`launcher exited ${code}`)); }
      });
    });
    wrapperPid = pids.wrapperPid;
    harperPid = pids.harperPid;
    expect(wrapperPid).toBeGreaterThan(0);
    expect(harperPid).toBeGreaterThan(0);

    await waitUntil(`parent-exit marker; launcher stderr: ${launcherStderr}`, () => existsSync(exitFile));
    expect(readFileSync(exitFile, "utf-8")).toBe("parent");
    expect(existsSync(rootPath)).toBe(false);
    await waitUntil("parentless recovery wrapper exit", () => !processRunning(wrapperPid!));
  } finally {
    killPid(launcher?.pid);
    killPid(wrapperPid ?? recordedMockPid(rootPath, "mock-wrapper.pid"));
    killPid(harperPid ?? recordedMockPid(rootPath, "mock-child.pid"));
    try { rmSync(rootPath, { recursive: true, force: true }); } catch {}
    try { unlinkSync(exitFile); } catch {}
  }
}, TEST_TIMEOUT_MS);
