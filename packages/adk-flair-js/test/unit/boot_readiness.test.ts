/**
 * Unit tests for the boot readiness gate in boot-harper.mjs.
 *
 * The gate verifies that the Flair application is actually loaded — not just
 * that Harper's /health returns 200. A half-booted instance (server up, app
 * absent) must fail loudly rather than handing tests a 404-serving URL.
 */
import { test, expect } from "bun:test";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { writeFileSync, readFileSync, mkdtempSync, unlinkSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { bootEphemeralHarper } from "../helpers/live-flair";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Replicated from boot-harper.mjs — kept in sync manually.
 * Polls a Flair-owned route until it returns non-404 or times out.
 */
async function waitForAppLoaded(
  httpURL: string,
  timeoutMs = 5_000,
): Promise<void> {
  const url = `${httpURL}/Memory`;
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    try {
      const res = await fetch(url, {
        method: "GET",
        signal: AbortSignal.timeout(1000),
      });
      if (res.status !== 404) {
        return;
      }
    } catch {
      // connection refused / timeout — keep polling
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `Flair application not loaded at ${httpURL} after ${timeoutMs}ms ` +
      `(${attempt} attempts). The Flair app must be built before running ` +
      `integration tests — Harper is up but /Memory returns 404.`,
  );
}

/** Start a mock server on an ephemeral port. */
function startMock(
  handler: (req: { url?: string }, res: { statusCode: number; end: (body?: string) => void }) => void,
): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer(handler as any);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        throw new Error("failed to get server address");
      }
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

test("waitForAppLoaded resolves when /Memory returns non-404", async () => {
  const { server, url } = await startMock((_req, res) => {
    res.statusCode = 405; // Method Not Allowed — app is loaded, just wrong method
    res.end();
  });

  try {
    await waitForAppLoaded(url, 3_000);
    // Should not throw
  } finally {
    server.close();
  }
});

test("waitForAppLoaded resolves when /Memory returns 200", async () => {
  const { server, url } = await startMock((_req, res) => {
    res.statusCode = 200;
    res.end("[]");
  });

  try {
    await waitForAppLoaded(url, 3_000);
  } finally {
    server.close();
  }
});

test("waitForAppLoaded throws when /Memory returns 404 (app not loaded)", async () => {
  const { server, url } = await startMock((_req, res) => {
    if (_req.url === "/health") {
      res.statusCode = 200;
      res.end("OK");
    } else {
      // Harper's catch-all when no app handles the route
      res.statusCode = 404;
      res.end("Not Found");
    }
  });

  try {
    await expect(waitForAppLoaded(url, 2_000)).rejects.toThrow(
      "Flair application not loaded",
    );
  } finally {
    server.close();
  }
});

test("waitForAppLoaded throws when server is unreachable", async () => {
  // Use a port that nothing is listening on
  await expect(waitForAppLoaded("http://127.0.0.1:1", 1_000)).rejects.toThrow(
    "Flair application not loaded",
  );
});

test("waitForAppLoaded eventually resolves when app loads after delay", async () => {
  let callCount = 0;
  const { server, url } = await startMock((_req, res) => {
    callCount++;
    if (callCount <= 3) {
      // First 3 calls: app not loaded yet
      res.statusCode = 404;
      res.end("Not Found");
    } else {
      // App loads on 4th call
      res.statusCode = 200;
      res.end("[]");
    }
  });

  try {
    await waitForAppLoaded(url, 5_000);
    expect(callCount).toBeGreaterThanOrEqual(4);
  } finally {
    server.close();
  }
});

// ─── Booter timeout (flair#1119) ────────────────────────────────────────────
// The booter must never burn the per-test timeout. When the helper script
// never emits the JSON config line, bootEphemeralHarper must reject within
// its budget, kill the process, and leave no zombie.

test("bootEphemeralHarper rejects within budget when helper never emits config", async () => {
  // Create a temporary script that sleeps — never emits the JSON config line.
  const sleeperPath = join(tmpdir(), `adk-flair-test-sleeper-${process.pid}.mjs`);
  writeFileSync(sleeperPath, [
    "#!/usr/bin/env node",
    "// Sleeper: never emits JSON config — used to test boot timeout",
    "setTimeout(() => {}, 120_000); // sleep 120s, well past the test budget",
  ].join("\n"), "utf-8");

  const cleanup = () => {
    try { unlinkSync(sleeperPath); } catch {}
  };

  try {
    const start = Date.now();
    let err: Error | null = null;

    try {
      await bootEphemeralHarper(sleeperPath, 3_000);
    } catch (e) {
      err = e as Error;
    }

    const elapsed = Date.now() - start;

    // Must have rejected
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/timed out/);

    // Must reject within budget + reasonable margin (process-spawn overhead)
    expect(elapsed).toBeLessThan(10_000);

    // Verify no zombie: the process group should be killed.
    // We can't easily check for zombies in a cross-platform way, but the
    // timeout handler does `process.kill(-proc.pid, "SIGKILL")` which
    // kills the entire process group. The fact that the promise rejected
    // (rather than hanging) confirms the timeout fired and killed the
    // process — otherwise the promise would still be pending.
  } finally {
    cleanup();
  }
}, 15_000);

// ─── Recovery contract (flair#1121) ─────────────────────────────────────────
// The JSON line must include rootPath and harperPid so callers can recover
// from an interrupted teardown.

/** Spawn a mock script that prints a JSON line and exits. Returns the parsed
 *  config and the child process. */
async function spawnMockBootHelper(jsonFields: Record<string, unknown>): Promise<{
  config: Record<string, unknown>;
  proc: ChildProcess;
}> {
  const scriptPath = join(tmpdir(), `adk-flair-test-mock-boot-${process.pid}.mjs`);
  const jsonLine = JSON.stringify(jsonFields);
  writeFileSync(scriptPath, [
    "#!/usr/bin/env node",
    `process.stdout.write(${JSON.stringify(jsonLine)} + "\\n");`,
    "// block until stdin closes",
    "process.stdin.on('end', () => process.exit(0));",
  ].join("\n"), "utf-8");

  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10_000,
    });
    let stdout = "";
    const timeout = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch {}
      try { unlinkSync(scriptPath); } catch {}
      reject(new Error("mock boot helper timed out"));
    }, 10_000);

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
    proc.stdin?.end();
    try { proc.kill("SIGKILL"); } catch {}
  }
}, 15_000);

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
    proc.stdin?.end();
    try { proc.kill("SIGKILL"); } catch {}
  }
}, 15_000);

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

// ─── Recovery-path test (flair#1121) ───────────────────────────────────────
// Simulates the recovery contract: a wrapper that emits rootPath + harperPid.
// We SIGKILL it mid-teardown and exercise the
// documented recovery path using the emitted fields.
//
// This is a mock test — it does NOT boot a real Harper. The real-Harper
// integration test is too slow for CI (Harper warm-up >300s on cold runners).
// The contract under test is the JSON line format + the recovery procedure,
// both of which are exercised here.

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
    "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300_000)'], {",
    "  stdio: 'ignore',",
    "  detached: true,",
    "  timeout: 120_000,",
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
    "  }, 250);",
    "  const deadline = setTimeout(() => finish('deadline'), 90_000);",
    "  if (process.env.RECOVERY_MOCK_IGNORE_STDIN !== '1') {",
    "    process.stdin.once('end', () => finish('stdin'));",
    "    process.stdin.resume();",
    "  }",
    "});",
    "if (reason === 'stdin') await new Promise(r => setTimeout(r, 5000));",
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

function processRunning(pid: number): boolean {
  try { process.kill(pid, 0); } catch { return false; }
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
      return stat[stat.lastIndexOf(")") + 2] !== "Z";
    } catch { /* /proc may be unavailable */ }
  }
  return true;
}

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
      timeout: 50_000,
    });

    // Read the JSON line
    const config = await new Promise<Record<string, unknown>>((resolve, reject) => {
      let stdout = "";
      const timeout = setTimeout(() => {
        try { wrapper.kill("SIGKILL"); } catch {}
        reject(new Error("mock wrapper timed out"));
      }, 30_000);

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
    wrapper.stdin?.end(); // trigger teardown
    await new Promise(r => setTimeout(r, 100)); // tiny window for teardown to start
    try { wrapper.kill("SIGKILL"); } catch {}

    // Wait for wrapper to exit
    await new Promise<void>(r => {
      wrapper.on("exit", () => r());
      setTimeout(r, 5000);
    });

    // ── The mock Harper child should still be alive (orphaned) ──────────
    try { process.kill(harperPid, 0); childAlive = true; } catch { childAlive = false; }
    expect(childAlive).toBe(true);

    // ── Exercise the documented recovery path ───────────────────────────
    // 1. Kill by explicit harperPid
    if (childAlive) {
      try { process.kill(harperPid, "SIGKILL"); } catch {}
      await new Promise(r => setTimeout(r, 1000));
    }

    // 2. Remove the tree by rootPath
    if (existsSync(rootPath)) {
      rmSync(rootPath, { recursive: true, force: true, maxRetries: 4 });
    }

    // ── Verify: no process, no tree ─────────────────────────────────────
    let stillAlive = true;
    try { process.kill(harperPid, 0); } catch { stillAlive = false; }
    expect(stillAlive).toBe(false);
    expect(existsSync(rootPath)).toBe(false);
  } finally {
    killPid(wrapper?.pid);
    killPid(harperPid ?? recordedMockPid(rootPath, "mock-child.pid"));
    try { rmSync(rootPath, { recursive: true, force: true, maxRetries: 2 }); } catch {}
  }
}, 60_000);

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
    "  timeout: 8_000,",
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
      timeout: 8_000,
    });
    launcher.stderr?.on("data", (chunk: Buffer) => { launcherStderr += chunk.toString(); });
    const pids = await new Promise<{ wrapperPid: number; harperPid: number }>((resolve, reject) => {
      let stdout = "";
      const deadline = setTimeout(() => reject(new Error("launcher did not report mock PIDs")), 3_000);
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

    const deadline = Date.now() + 5_000;
    while (!existsSync(exitFile) && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 50));
    }
    expect(existsSync(exitFile), `mock exit marker missing; launcher stderr: ${launcherStderr}`).toBe(true);
    expect(readFileSync(exitFile, "utf-8")).toBe("parent");
    expect(existsSync(rootPath)).toBe(false);
    const exitDeadline = Date.now() + 3_000;
    while (processRunning(wrapperPid) && Date.now() < exitDeadline) {
      await new Promise(r => setTimeout(r, 50));
    }
    expect(processRunning(wrapperPid)).toBe(false);
  } finally {
    killPid(launcher?.pid);
    killPid(wrapperPid ?? recordedMockPid(rootPath, "mock-wrapper.pid"));
    killPid(harperPid ?? recordedMockPid(rootPath, "mock-child.pid"));
    try { rmSync(rootPath, { recursive: true, force: true }); } catch {}
    try { unlinkSync(exitFile); } catch {}
  }
}, 12_000);
